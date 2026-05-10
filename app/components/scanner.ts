import Component from '@glimmer/component';

// ─── Types ────────────────────────────────────────────────────────────────────

type Point = [number, number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CV = any;

declare global {
  interface Window {
    cv: CV;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jspdf: { jsPDF: new (...args: any[]) => any };
    cvReady?: boolean;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default class Scanner extends Component {
  // ── Constants ──────────────────────────────────────────────────────────────
  private readonly DETECT_INTERVAL_MS = 250;
  private readonly DETECT_MAX_DIM = 640;
  private readonly RECENT_KEY = 'scanner_recents';
  private readonly RECENT_MAX = 4;
  private readonly THUMB_SIZE = 200;

  // ── Mutable state (not @tracked – UI is fully imperative) ─────────────────
  private stream: MediaStream | null = null;
  private capturedImageData: ImageData | null = null;
  private capturedWidth = 0;
  private capturedHeight = 0;
  private corners: Point[] = [];
  private draggingCorner = -1;
  private cvReady = false;
  private liveCorners: Point[] | null = null;
  private detectionTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupCornerEvents: (() => void) | null = null;
  private selectedFormat = 'auto';
  private selectedQuality = 'high';

  // ── DOM refs (populated in initScanner) ────────────────────────────────────
  private detectCanvas!: HTMLCanvasElement;
  private video!: HTMLVideoElement;
  private overlay!: HTMLCanvasElement;
  private previewCanvas!: HTMLCanvasElement;
  private cornerCanvas!: HTMLCanvasElement;
  private resultCanvas!: HTMLCanvasElement;
  private magnifierDiv!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private loadingText!: HTMLElement;
  private detectBadge!: HTMLElement;
  private scanGuide!: HTMLElement;
  private exportModal!: HTMLElement;
  private camHint!: HTMLElement;
  private recentsGrid!: HTMLElement;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  willDestroy(): void {
    super.willDestroy();
    this.stopCamera();
    this.cleanupCornerEvents?.();
  }

  // ── Entry point – called by {{did-insert}} ─────────────────────────────────

  public initScanner = (_element: HTMLElement): void => {
    this.detectCanvas = document.createElement('canvas');
    this.video = this.el<HTMLVideoElement>('video');
    this.overlay = this.el<HTMLCanvasElement>('overlay');
    this.previewCanvas = this.el<HTMLCanvasElement>('preview-canvas');
    this.cornerCanvas = this.el<HTMLCanvasElement>('corner-canvas');
    this.resultCanvas = this.el<HTMLCanvasElement>('result-canvas');
    this.magnifierDiv = this.el('magnifier');
    this.loadingOverlay = this.el('loading-overlay');
    this.loadingText = this.el('loading-text');
    this.detectBadge = this.el('detect-badge');
    this.scanGuide = this.el('scan-guide');
    this.exportModal = this.el('export-modal');
    this.camHint = this.el('cam-hint');
    this.recentsGrid = this.el('recents-grid');

    this.el('start-scan-btn').addEventListener('click', () => this.startCamera());
    this.el('close-camera-btn').addEventListener('click', () => {
      this.stopCamera();
      this.showScreen('home-view');
    });
    this.el('capture-btn').addEventListener('click', () => this.captureFrame());
    this.el('retake-btn').addEventListener('click', () => {
      this.cleanupCornerEvents?.();
      this.capturedImageData = null;
      this.corners = [];
      this.liveCorners = null;
      this.showScreen('camera-view');
      this.startDetectionLoop();
    });
    this.el('confirm-btn').addEventListener('click', () => this.processDocument());
    this.el('auto-fix-btn').addEventListener('click', () => this.autoFix());
    this.el('scan-again-btn').addEventListener('click', () => {
      this.capturedImageData = null;
      this.corners = [];
      this.liveCorners = null;
      this.showScreen('home-view');
      this.stopCamera();
    });
    this.el('save-image-btn').addEventListener('click', () => this.saveImage());
    this.el('export-pdf-btn').addEventListener('click', () => this.openExportModal());
    this.el('share-btn').addEventListener('click', () => this.shareImage());
    this.el('clear-recents-btn').addEventListener('click', () => {
      localStorage.removeItem(this.RECENT_KEY);
      this.renderRecents();
    });
    this.el('modal-cancel').addEventListener('click', () => this.closeExportModal());
    this.el('modal-export').addEventListener('click', () => this.exportPDF());
    this.exportModal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this.exportModal) this.closeExportModal();
    });
    this.setupSegment('format-seg', (val) => {
      this.selectedFormat = val;
    });
    this.setupSegment('quality-seg', (val) => {
      this.selectedQuality = val;
    });

    this.renderRecents();
    this.waitForCv(() => console.log('OpenCV ready'));
  }

  // ── DOM helper ─────────────────────────────────────────────────────────────

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  // ── Screen management ──────────────────────────────────────────────────────

  private showScreen(id: string): void {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
  }

  private showLoading(text = 'Processing…'): void {
    this.loadingText.textContent = text;
    this.loadingOverlay.classList.add('active');
  }

  private hideLoading(): void {
    this.loadingOverlay.classList.remove('active');
  }

  private showError(msg: string): void {
    const div = document.createElement('div');
    div.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:20px;z-index:300;padding:32px;text-align:center;
    `;
    div.innerHTML = `
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#ff5555" stroke-width="1.8">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <p style="color:#fff;font-size:15px;line-height:1.6;max-width:280px;">${msg}</p>
      <button onclick="location.reload()" style="background:#00C896;color:#000;border:none;
        padding:14px 32px;border-radius:24px;font-size:14px;font-weight:600;cursor:pointer;">Reload</button>
    `;
    document.body.appendChild(div);
  }

  // ── Camera ─────────────────────────────────────────────────────────────────

  private async startCamera(): Promise<void> {
    this.showLoading('Starting camera…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await new Promise<void>((res) => {
        this.video.onloadedmetadata = () => res();
      });
      await this.video.play();
      this.overlay.width = this.video.videoWidth;
      this.overlay.height = this.video.videoHeight;
      this.hideLoading();
      this.showScreen('camera-view');
      this.startDetectionLoop();
    } catch {
      this.hideLoading();
      this.showScreen('home-view');
      this.showError('Camera access denied. Please allow camera access and reload the page.');
    }
  }

  private stopCamera(): void {
    this.stopDetectionLoop();
    this.clearOverlay();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.liveCorners = null;
    this.detectBadge?.classList.remove('visible');
    this.scanGuide?.classList.remove('detected');
  }

  // ── Real-time Detection Loop ───────────────────────────────────────────────

  private startDetectionLoop(): void {
    if (this.detectionTimer !== null) return;
    this.detectionTimer = setInterval(() => this.runDetection(), this.DETECT_INTERVAL_MS);
  }

  private stopDetectionLoop(): void {
    if (this.detectionTimer !== null) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
  }

  private runDetection(): void {
    if (!this.cvReady || !this.video.videoWidth || !this.video.videoHeight) return;
    if (!document.getElementById('camera-view')?.classList.contains('active')) return;

    const scale = Math.min(
      1,
      this.DETECT_MAX_DIM / Math.max(this.video.videoWidth, this.video.videoHeight),
    );
    const dw = Math.round(this.video.videoWidth * scale);
    const dh = Math.round(this.video.videoHeight * scale);
    this.detectCanvas.width = dw;
    this.detectCanvas.height = dh;
    this.detectCanvas.getContext('2d')!.drawImage(this.video, 0, 0, dw, dh);

    const found = this.detectDocumentCorners(this.detectCanvas);
    if (found) {
      this.liveCorners = found.map(([x, y]) => [x / scale, y / scale] as Point);
      this.drawOverlay(this.liveCorners);
      this.detectBadge.classList.add('visible');
      this.scanGuide.classList.add('detected');
      this.camHint.textContent = 'Document detected – tap to capture';
    } else {
      this.liveCorners = null;
      this.clearOverlay();
      this.detectBadge.classList.remove('visible');
      this.scanGuide.classList.remove('detected');
      this.camHint.textContent = 'Align document within frame';
    }
  }

  private drawOverlay(pts: Point[]): void {
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.strokeStyle = '#00C896';
    ctx.lineWidth = Math.max(3, this.overlay.width * 0.004);
    ctx.shadowColor = 'rgba(0,200,150,0.6)';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const r = Math.max(8, this.overlay.width * 0.012);
    pts.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#00C896';
      ctx.shadowColor = 'rgba(0,200,150,0.7)';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  private clearOverlay(): void {
    this.overlay?.getContext('2d')!.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  // ── OpenCV: detect 4-corner document ──────────────────────────────────────

  private detectDocumentCorners(canvas: HTMLCanvasElement): Point[] | null {
    const cv: CV = window.cv;
    // --- Pre-declare all Mats for safe cleanup in finally block ---
    let src: any = null, gray: any = null, blurred: any = null, edges: any = null, dilated: any = null;
    let kernel3: any = null, kernel7: any = null, kernel15: any = null;
    let gradX: any = null, gradY: any = null, absX: any = null, absY: any = null, gradMag: any = null;
    let channels: any = null, blueChannel: any = null, blueEdges: any = null;
    let adaptive: any = null;
    let contours: any = null, hierarchy: any = null, bestApprox: any = null;
    let bestArea = 0;

    try {
      src = cv.imread(canvas);
      const imgArea = canvas.width * canvas.height;
      
      // Initialize common Mats
      gray = new cv.Mat();
      blurred = new cv.Mat();
      edges = new cv.Mat();
      dilated = new cv.Mat();
      kernel3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      kernel7 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
      kernel15 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      
      // Helper to find the best quadrilateral from a binary/edge map
      const findQuad = (map: any, minFactor = 0.1, maxFactor = 0.9): any => {
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
        contours = new cv.MatVector();
        hierarchy = new cv.Mat();
        
        cv.findContours(map, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        
        let foundApprox: any = null;
        let foundArea = 0;

        for (let i = 0; i < contours.size(); i++) {
          const c = contours.get(i);
          const area = cv.contourArea(c);
          c.delete();
          
          if (area < imgArea * minFactor || area > imgArea * maxFactor) continue;

          const cont = contours.get(i);
          const peri = cv.arcLength(cont, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(cont, approx, 0.02 * peri, true);
          cont.delete();

          if (approx.rows === 4 && area > foundArea) {
            foundApprox?.delete();
            foundArea = area;
            foundApprox = approx;
          } else {
            approx.delete();
          }
        }
        return { approx: foundApprox, area: foundArea };
      };

      // --- STRATEGY 1: Shadow detection (Shadow edges at boundary) ---
      const meanScalar = cv.mean(gray);
      const isLight = meanScalar[0] > 150;
      
      // Use large blur to ignore text but keep document silhouette
      cv.GaussianBlur(gray, blurred, new cv.Size(21, 21), 0);
      
      // Ultra-low thresholds to catch the faint shadow "lip"
      cv.Canny(blurred, edges, 15, 45);
      // Heavy dilation to bridge gaps in faint shadow edges
      cv.dilate(edges, dilated, kernel7, new cv.Point(-1, -1), 3);
      
      const res1 = findQuad(dilated, isLight ? 0.15 : 0.1, 0.9);
      if (res1.approx) {
        bestApprox = res1.approx;
        bestArea = res1.area;
      }

      // --- STRATEGY 2: Sobel Gradient Magnitude (Texture/Contrast boundary) ---
      if (!bestApprox) {
        gradX = new cv.Mat();
        gradY = new cv.Mat();
        absX = new cv.Mat();
        absY = new cv.Mat();
        gradMag = new cv.Mat();

        cv.Sobel(blurred, gradX, cv.CV_16S, 1, 0, 3);
        cv.Sobel(blurred, gradY, cv.CV_16S, 0, 1, 3);
        cv.convertScaleAbs(gradX, absX);
        cv.convertScaleAbs(gradY, absY);
        cv.addWeighted(absX, 0.5, absY, 0.5, 0, gradMag);
        
        // Otsu automatically finds the best threshold for texture boundaries
        cv.threshold(gradMag, edges, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
        cv.dilate(edges, dilated, kernel3);
        
        const res2 = findQuad(dilated, 0.1, 0.9);
        if (res2.approx) {
          bestApprox = res2.approx;
          bestArea = res2.area;
        }
      }

      // --- STRATEGY 3: Blue Channel Split (Spectral difference) ---
      if (!bestApprox) {
        channels = new cv.MatVector();
        cv.split(src, channels);
        blueChannel = channels.get(2); // Blue is usually channel 2 in RGBA
        
        cv.GaussianBlur(blueChannel, blurred, new cv.Size(5, 5), 0);
        cv.Canny(blurred, blueEdges, 30, 100);
        cv.dilate(blueEdges, dilated, kernel3);
        
        const res3 = findQuad(dilated, 0.1, 0.9);
        if (res3.approx) {
          bestApprox = res3.approx;
          bestArea = res3.area;
        }
      }

      // --- STRATEGY 4: Adaptive Threshold Fallback ---
      if (!bestApprox) {
        adaptive = new cv.Mat();
        // Local thresholding is best for high-brightness/low-contrast
        cv.adaptiveThreshold(gray, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 4);
        // Fill in internal gaps (text) to reveal the document box
        cv.morphologyEx(adaptive, dilated, cv.MORPH_CLOSE, kernel15);
        
        const res4 = findQuad(dilated, 0.1, 0.9);
        if (res4.approx) {
          bestApprox = res4.approx;
          bestArea = res4.area;
        }
      }

      // --- Final result assembly ---
      if (bestApprox) {
        const pts: Point[] = [];
        for (let i = 0; i < 4; i++) {
          pts.push([bestApprox.data32S[i * 2], bestApprox.data32S[i * 2 + 1]]);
        }
        return this.orderCorners(pts);
      }
      
      return null;
    } catch (e) {
      console.warn('Edge detection error:', e);
      return null;
    } finally {
      // --- Aggressive Cleanup ---
      [src, gray, blurred, edges, dilated, kernel3, kernel7, kernel15, 
       gradX, gradY, absX, absY, gradMag, blueChannel, blueEdges, 
       adaptive, contours, hierarchy, bestApprox].forEach(m => {
        try { m?.delete(); } catch {}
      });
      if (channels) {
        try { channels.delete(); } catch {}
      }
    }
  }

  private orderCorners(pts: Point[]): Point[] {
    const sorted = [...pts].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
    const tl = sorted[0]!;
    const br = sorted[3]!;
    const mid = [sorted[1]!, sorted[2]!];
    const tr = mid[0]![0] >= mid[1]![0] ? mid[0]! : mid[1]!;
    const bl = mid[0]![0] >= mid[1]![0] ? mid[1]! : mid[0]!;
    return [tl, tr, br, bl];
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  private captureFrame(): void {
    if (!this.video.videoWidth) return;
    this.stopDetectionLoop();
    this.clearOverlay();

    this.capturedWidth = this.video.videoWidth;
    this.capturedHeight = this.video.videoHeight;

    const tmp = document.createElement('canvas');
    tmp.width = this.capturedWidth;
    tmp.height = this.capturedHeight;
    tmp.getContext('2d')!.drawImage(this.video, 0, 0, this.capturedWidth, this.capturedHeight);
    this.capturedImageData = tmp
      .getContext('2d')!
      .getImageData(0, 0, this.capturedWidth, this.capturedHeight);

    this.previewCanvas.width = this.capturedWidth;
    this.previewCanvas.height = this.capturedHeight;
    this.previewCanvas.getContext('2d')!.putImageData(this.capturedImageData, 0, 0);

    this.corners =
      this.liveCorners ??
      (this.cvReady ? this.detectDocumentCorners(tmp) : null) ??
      this.defaultCorners(this.capturedWidth, this.capturedHeight);

    this.setupCornerCanvas();
    this.showScreen('preview-view');
  }

  private defaultCorners(w: number, h: number): Point[] {
    const mx = w * 0.08;
    const my = h * 0.08;
    return [
      [mx, my],
      [w - mx, my],
      [w - mx, h - my],
      [mx, h - my],
    ];
  }

  // ── Corner Canvas – manual adjustment ─────────────────────────────────────

  private setupCornerCanvas(): void {
    this.cornerCanvas.width = this.capturedWidth;
    this.cornerCanvas.height = this.capturedHeight;
    this.drawCorners();
    this.cleanupCornerEvents?.();

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0]!;
      this.draggingCorner = this.nearestCorner(
        ...this.canvasCoords(this.cornerCanvas, t.clientX, t.clientY),
      );
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (this.draggingCorner < 0) return;
      const t = e.touches[0]!;
      const [x, y] = this.canvasCoords(this.cornerCanvas, t.clientX, t.clientY);
      this.moveCorner(this.draggingCorner, x, y);
      this.drawMagnifier(x, y, t.clientX, t.clientY);
    };
    const onTouchEnd = () => {
      this.draggingCorner = -1;
      this.hideMagnifier();
    };
    const onMouseDown = (e: MouseEvent) => {
      this.draggingCorner = this.nearestCorner(
        ...this.canvasCoords(this.cornerCanvas, e.clientX, e.clientY),
      );
    };
    const onMouseMove = (e: MouseEvent) => {
      if (this.draggingCorner < 0) return;
      const [x, y] = this.canvasCoords(this.cornerCanvas, e.clientX, e.clientY);
      this.moveCorner(this.draggingCorner, x, y);
    };
    const onMouseUp = () => {
      this.draggingCorner = -1;
      this.hideMagnifier();
    };

    this.cornerCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
    this.cornerCanvas.addEventListener('touchmove', onTouchMove, { passive: false });
    this.cornerCanvas.addEventListener('touchend', onTouchEnd);
    this.cornerCanvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    this.cleanupCornerEvents = () => {
      this.cornerCanvas.removeEventListener('touchstart', onTouchStart);
      this.cornerCanvas.removeEventListener('touchmove', onTouchMove);
      this.cornerCanvas.removeEventListener('touchend', onTouchEnd);
      this.cornerCanvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }

  private canvasCoords(canvas: HTMLCanvasElement, cx: number, cy: number): Point {
    const r = canvas.getBoundingClientRect();
    return [
      (cx - r.left) * (canvas.width / r.width),
      (cy - r.top) * (canvas.height / r.height),
    ];
  }

  private nearestCorner(x: number, y: number): number {
    const threshold = Math.min(this.capturedWidth, this.capturedHeight) * 0.1;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.corners.length; i++) {
      const d = this.dist(this.corners[i]!, [x, y]);
      if (d < threshold && d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  private moveCorner(idx: number, x: number, y: number): void {
    this.corners[idx] = [
      Math.max(0, Math.min(this.capturedWidth, x)),
      Math.max(0, Math.min(this.capturedHeight, y)),
    ];
    this.drawCorners();
  }

  private drawCorners(): void {
    const ctx = this.cornerCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.cornerCanvas.width, this.cornerCanvas.height);

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, 0, this.cornerCanvas.width, this.cornerCanvas.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(this.corners[0]![0], this.corners[0]![1]);
    this.corners.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(this.corners[0]![0], this.corners[0]![1]);
    this.corners.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
    ctx.strokeStyle = '#00C896';
    ctx.lineWidth = Math.max(3, this.capturedWidth * 0.004);
    ctx.stroke();

    const r = Math.max(18, Math.min(this.capturedWidth, this.capturedHeight) * 0.035);
    this.corners.forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#00C896';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - r * 0.38, y);
      ctx.lineTo(x + r * 0.38, y);
      ctx.moveTo(x, y - r * 0.38);
      ctx.lineTo(x, y + r * 0.38);
      ctx.stroke();
    });
  }

  // ── Magnifier ──────────────────────────────────────────────────────────────

  private drawMagnifier(
    canvasX: number,
    canvasY: number,
    clientX: number,
    clientY: number,
  ): void {
    const SIZE = 80;
    const ZOOM = 2.5;
    const container = document.getElementById('preview-container')!;
    const cr = container.getBoundingClientRect();
    let mx = clientX - cr.left - SIZE / 2;
    let my = clientY - cr.top - SIZE - 20;
    if (my < 4) my = clientY - cr.top + 24;
    mx = Math.max(4, Math.min(cr.width - SIZE - 4, mx));

    this.magnifierDiv.style.display = 'block';
    this.magnifierDiv.style.left = `${mx}px`;
    this.magnifierDiv.style.top = `${my}px`;

    const mCtx = document.createElement('canvas');
    mCtx.width = SIZE;
    mCtx.height = SIZE;
    const ctx = mCtx.getContext('2d')!;
    ctx.drawImage(
      this.previewCanvas,
      canvasX - SIZE / 2 / ZOOM,
      canvasY - SIZE / 2 / ZOOM,
      SIZE / ZOOM,
      SIZE / ZOOM,
      0,
      0,
      SIZE,
      SIZE,
    );
    ctx.strokeStyle = 'rgba(0,200,150,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, 0);
    ctx.lineTo(SIZE / 2, SIZE);
    ctx.moveTo(0, SIZE / 2);
    ctx.lineTo(SIZE, SIZE / 2);
    ctx.stroke();

    this.magnifierDiv.innerHTML = '';
    this.magnifierDiv.appendChild(mCtx);
  }

  private hideMagnifier(): void {
    this.magnifierDiv.style.display = 'none';
  }

  // ── Auto Fix ───────────────────────────────────────────────────────────────

  private autoFix(): void {
    if (!this.capturedImageData) return;
    const tmp = document.createElement('canvas');
    tmp.width = this.capturedWidth;
    tmp.height = this.capturedHeight;
    tmp.getContext('2d')!.putImageData(this.capturedImageData, 0, 0);

    const detected = this.cvReady ? this.detectDocumentCorners(tmp) : null;
    if (detected) {
      this.corners = detected;
      this.drawCorners();
    } else {
      const hint = document.createElement('div');
      hint.textContent = 'No document edges found – adjust manually';
      hint.style.cssText = `
        position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
        background:rgba(255,80,80,0.9);color:#fff;padding:10px 18px;border-radius:20px;
        font-size:13px;z-index:100;
      `;
      document.body.appendChild(hint);
      setTimeout(() => hint.remove(), 2400);
    }
  }

  // ── Process Document (keep color, no B&W) ─────────────────────────────────

  private processDocument(): void {
    if (!this.capturedImageData) return;
    if (!this.cvReady) {
      alert('OpenCV is still loading, please wait a moment.');
      return;
    }
    this.showLoading('Cropping & enhancing…');
    setTimeout(() => {
      const cv: CV = window.cv;
      let src, srcPts, dstPts, M, warped, brightened, kernel, sharpened;
      try {
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = this.capturedWidth;
        srcCanvas.height = this.capturedHeight;
        srcCanvas.getContext('2d')!.putImageData(this.capturedImageData!, 0, 0);
        src = cv.imread(srcCanvas);

        // Inset corners – top gets a larger nudge
        const ixSide = this.capturedWidth * 0.018;
        const iyTop = this.capturedHeight * 0.028;
        const iyBottom = this.capturedHeight * 0.018;
        const [tl, tr, br, bl] = this.corners as [Point, Point, Point, Point];
        const ic: Point[] = [
          [tl[0] + ixSide, tl[1] + iyTop],
          [tr[0] - ixSide, tr[1] + iyTop],
          [br[0] - ixSide, br[1] - iyBottom],
          [bl[0] + ixSide, bl[1] - iyBottom],
        ];

        const W = Math.round(Math.max(this.dist(ic[1]!, ic[0]!), this.dist(ic[2]!, ic[3]!)));
        const H = Math.round(Math.max(this.dist(ic[0]!, ic[3]!), this.dist(ic[1]!, ic[2]!)));
        if (W < 10 || H < 10) throw new Error('Selection area too small');

        srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
          ic[0]![0], ic[0]![1], ic[1]![0], ic[1]![1],
          ic[2]![0], ic[2]![1], ic[3]![0], ic[3]![1],
        ]);
        dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W - 1, 0, W - 1, H - 1, 0, H - 1]);
        M = cv.getPerspectiveTransform(srcPts, dstPts);
        warped = new cv.Mat();
        cv.warpPerspective(src, warped, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);

        // Brightness + contrast lift (full color)
        brightened = new cv.Mat();
        warped.convertTo(brightened, -1, 1.12, 18);

        // Single mild sharpen
        kernel = cv.matFromArray(3, 3, cv.CV_32F, [0, -0.4, 0, -0.4, 2.6, -0.4, 0, -0.4, 0]);
        sharpened = new cv.Mat();
        cv.filter2D(brightened, sharpened, -1, kernel);

        this.resultCanvas.width = W;
        this.resultCanvas.height = H;
        cv.imshow(this.resultCanvas, sharpened);
        this.saveRecentScan();
        this.hideLoading();
        this.showScreen('result-view');
      } catch (e) {
        this.hideLoading();
        console.error('Processing error:', e);
        alert('Could not process the image. Try adjusting the corners and confirming again.');
      } finally {
        src?.delete();
        srcPts?.delete();
        dstPts?.delete();
        M?.delete();
        warped?.delete();
        brightened?.delete();
        kernel?.delete();
        sharpened?.delete();
      }
    }, 60);
  }

  private dist(a: Point, b: Point): number {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  }

  // ── Recent Scans ───────────────────────────────────────────────────────────

  private saveRecentScan(): void {
    try {
      const thumb = document.createElement('canvas');
      const ratio = this.resultCanvas.width / this.resultCanvas.height;
      if (ratio >= 1) {
        thumb.width = this.THUMB_SIZE;
        thumb.height = Math.round(this.THUMB_SIZE / ratio);
      } else {
        thumb.height = this.THUMB_SIZE;
        thumb.width = Math.round(this.THUMB_SIZE * ratio);
      }
      thumb.getContext('2d')!.drawImage(this.resultCanvas, 0, 0, thumb.width, thumb.height);
      const dataUrl = thumb.toDataURL('image/jpeg', 0.7);
      const stored = JSON.parse(localStorage.getItem(this.RECENT_KEY) || '[]') as string[];
      stored.unshift(dataUrl);
      if (stored.length > this.RECENT_MAX) stored.length = this.RECENT_MAX;
      localStorage.setItem(this.RECENT_KEY, JSON.stringify(stored));
      this.renderRecents();
    } catch {
      /* storage may be unavailable */
    }
  }

  private renderRecents(): void {
    try {
      const stored = JSON.parse(localStorage.getItem(this.RECENT_KEY) || '[]') as string[];
      if (!stored.length) {
        this.recentsGrid.innerHTML = `
          <div class="no-recents">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.3">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span>No recent scans yet</span>
          </div>`;
        return;
      }
      this.recentsGrid.innerHTML = stored
        .map(
          (url, i) =>
            `<div class="recent-thumb" data-idx="${i}"><img src="${url}" alt="Scan ${i + 1}" loading="lazy"></div>`,
        )
        .join('');
    } catch {
      /* storage may be unavailable */
    }
  }

  // ── Export – PDF ───────────────────────────────────────────────────────────

  private openExportModal(): void {
    this.exportModal.classList.add('open');
  }

  private closeExportModal(): void {
    this.exportModal.classList.remove('open');
  }

  private exportPDF(): void {
    if (!this.resultCanvas.width) return;
    this.closeExportModal();
    this.showLoading('Generating PDF…');
    setTimeout(() => {
      try {
        const { jsPDF } = window.jspdf;
        const quality =
          this.selectedQuality === 'ultra' ? 1.0 : this.selectedQuality === 'high' ? 0.95 : 0.85;
        const imgData = this.resultCanvas.toDataURL('image/jpeg', quality);
        const cW = this.resultCanvas.width;
        const cH = this.resultCanvas.height;
        const isLandscape = cW > cH;

        const paperSizes: Record<string, [number, number]> = {
          a4: [210, 297],
          a3: [297, 420],
          letter: [215.9, 279.4],
        };

        let pdf;
        if (this.selectedFormat === 'auto') {
          const pxPerMm = 96 / 25.4;
          const wMm = cW / pxPerMm;
          const hMm = cH / pxPerMm;
          const orient = isLandscape ? 'landscape' : 'portrait';
          pdf = new jsPDF({ orientation: orient, unit: 'mm', format: [wMm, hMm] });
          pdf.addImage(imgData, 'JPEG', 0, 0, wMm, hMm, '', 'FAST');
        } else {
          let [pw, ph] = paperSizes[this.selectedFormat]!;
          if (isLandscape) [pw, ph] = [ph, pw];
          const orient = isLandscape ? 'landscape' : 'portrait';
          pdf = new jsPDF({
            orientation: orient,
            unit: 'mm',
            format:
              this.selectedFormat === 'a3'
                ? 'a3'
                : this.selectedFormat === 'a4'
                  ? 'a4'
                  : [pw!, ph!],
          });
          const margin = 8;
          const maxW = pw! - margin * 2;
          const maxH = ph! - margin * 2;
          const imgRatio = cW / cH;
          const pageRatio = maxW / maxH;
          let drawW: number, drawH: number;
          if (imgRatio > pageRatio) {
            drawW = maxW;
            drawH = maxW / imgRatio;
          } else {
            drawH = maxH;
            drawW = maxH * imgRatio;
          }
          const x = margin + (maxW - drawW) / 2;
          const y = margin + (maxH - drawH) / 2;
          pdf.addImage(imgData, 'JPEG', x, y, drawW, drawH, '', 'FAST');
        }

        const date = new Date().toISOString().slice(0, 10);
        pdf.save(`scan-${date}.pdf`);
        this.hideLoading();
      } catch (e) {
        this.hideLoading();
        console.error('PDF export error:', e);
        alert('PDF export failed. Please try again.');
      }
    }, 80);
  }

  // ── Save Image ─────────────────────────────────────────────────────────────

  private saveImage(): void {
    this.resultCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scan_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  // ── Share ──────────────────────────────────────────────────────────────────

  private async shareImage(): Promise<void> {
    if (!('share' in navigator)) {
      this.saveImage();
      return;
    }
    try {
      this.resultCanvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], `scan_${Date.now()}.png`, { type: 'image/png' });
        await navigator.share({ files: [file], title: 'Scanned Document' });
      }, 'image/png');
    } catch (e) {
      console.warn('Share failed:', e);
      this.saveImage();
    }
  }

  // ── Segmented controls ─────────────────────────────────────────────────────

  private setupSegment(containerId: string, onChange: (val: string) => void): void {
    const container = document.getElementById(containerId)!;
    container.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element).closest('.seg-btn') as HTMLButtonElement | null;
      if (!btn) return;
      container.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset['val']!);
    });
  }

  // ── OpenCV init ────────────────────────────────────────────────────────────

  private waitForCv(cb: () => void): void {
    const check = () => {
      try {
        if (typeof window.cv !== 'undefined' && window.cv.Mat) {
          this.cvReady = true;
          cb();
        } else {
          setTimeout(check, 200);
        }
      } catch {
        setTimeout(check, 200);
      }
    };
    if (window.cvReady) {
      check();
    } else {
      document.addEventListener('opencv-ready', () => setTimeout(check, 100));
      setTimeout(() => {
        if (!this.cvReady) check();
      }, 8000);
    }
  }
}

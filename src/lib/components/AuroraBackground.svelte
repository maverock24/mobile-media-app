<script lang="ts">
	import { onMount } from 'svelte';
	import { Capacitor } from '@capacitor/core';

	let canvas: HTMLCanvasElement;
	let raf: number;

	// ─── Cloud + Moon types ───────────────────────────────────────────────────────
	interface Wisp { dx: number; dy: number; rx: number; ry: number; a: number; }
	interface Blob { dx: number; dy: number; rx: number; ry: number; }
	interface Cloud {
		initX: number;
		yFrac: number;
		speed: number;
		scale: number;
		maxAlpha: number;
		shapeIdx: number;
		visPeriod: number;
		visPhase: number;
		stretchX?: number;   // horizontal stretch multiplier (default 1)
		pinToMoon?: boolean; // always drawn in front of moon, slow oscillation
	}

	// Wispy cirrus-style shapes – wide, thin, horizontally smeared (small clouds)
	const WISP_SHAPES: Wisp[][] = [
		// Shape 0 – long single-layer streak
		[
			{ dx:  0,     dy:  0,    rx: 2.40, ry: 0.22, a: 0.90 },
			{ dx:  0.55,  dy: -0.08, rx: 1.60, ry: 0.16, a: 0.70 },
			{ dx: -0.45,  dy:  0.07, rx: 1.40, ry: 0.15, a: 0.65 },
			{ dx:  1.30,  dy: -0.13, rx: 0.90, ry: 0.10, a: 0.45 },
			{ dx: -1.10,  dy:  0.11, rx: 0.80, ry: 0.09, a: 0.40 },
		],
		// Shape 1 – two-tier wispy layer
		[
			{ dx:  0,     dy:  0,    rx: 1.80, ry: 0.28, a: 0.85 },
			{ dx:  0,     dy: -0.18, rx: 1.20, ry: 0.18, a: 0.60 },
			{ dx:  0.65,  dy:  0.05, rx: 1.00, ry: 0.20, a: 0.65 },
			{ dx: -0.55,  dy:  0.06, rx: 0.90, ry: 0.18, a: 0.58 },
			{ dx:  1.50,  dy: -0.05, rx: 0.65, ry: 0.13, a: 0.38 },
			{ dx: -1.30,  dy: -0.04, rx: 0.58, ry: 0.12, a: 0.36 },
		],
	];

	// Fluffy blob shape for the large moon-covering cloud (shapeIdx 2)
	const BLOB_SHAPE: Blob[] = [
		{ dx:  0,     dy:  0,    rx: 1.10, ry: 0.54 },
		{ dx:  0.78,  dy:  0.04, rx: 0.76, ry: 0.48 },
		{ dx: -0.76,  dy:  0.06, rx: 0.70, ry: 0.45 },
		{ dx:  0.38,  dy: -0.34, rx: 0.62, ry: 0.42 },
		{ dx: -0.36,  dy: -0.32, rx: 0.58, ry: 0.40 },
		{ dx:  1.38,  dy:  0.18, rx: 0.48, ry: 0.36 },
		{ dx: -1.30,  dy:  0.22, rx: 0.44, ry: 0.34 },
		{ dx:  0.68,  dy: -0.46, rx: 0.40, ry: 0.30 },
		{ dx: -0.64,  dy: -0.44, rx: 0.38, ry: 0.28 },
	];

	let clouds: Cloud[] = [];
	let moonX = 0, moonY = 0, moonR = 0;

	function initClouds(w: number, h: number) {
		moonX = w * 0.70;
		moonY = h * 0.12;
		moonR = Math.min(w, h) * 0.033;
		clouds = [
			// Background clouds — smaller = more transparent, bigger = more opaque
			{ initX: w * 0.00,  yFrac: 0.05, speed: 3.2, scale: h * 0.048, maxAlpha: 0.76, shapeIdx: 2, visPeriod: 120, visPhase: 0.0, stretchX: 2.2 },
			{ initX: w * 0.20,  yFrac: 0.14, speed: 5.8, scale: h * 0.034, maxAlpha: 0.52, shapeIdx: 2, visPeriod: 100, visPhase: 1.8, stretchX: 1.8 },
			{ initX: w * 0.40,  yFrac: 0.06, speed: 2.4, scale: h * 0.058, maxAlpha: 0.88, shapeIdx: 2, visPeriod: 150, visPhase: 3.4, stretchX: 2.6 },
			{ initX: w * 0.60,  yFrac: 0.16, speed: 7.0, scale: h * 0.028, maxAlpha: 0.38, shapeIdx: 2, visPeriod:  85, visPhase: 5.1, stretchX: 1.6 },
			{ initX: w * 0.78,  yFrac: 0.08, speed: 4.2, scale: h * 0.042, maxAlpha: 0.66, shapeIdx: 2, visPeriod: 130, visPhase: 2.7, stretchX: 2.0 },
			{ initX: w * 1.00,  yFrac: 0.13, speed: 6.5, scale: h * 0.031, maxAlpha: 0.44, shapeIdx: 2, visPeriod:  95, visPhase: 4.2, stretchX: 1.9 },
			// Moon cloud – always in front of moon, slow oscillating drift
			{ initX: moonX, yFrac: 0.12, speed: 0, scale: h * 0.052, maxAlpha: 0.85, shapeIdx: 2, visPeriod: 1, visPhase: 0, pinToMoon: true },
		];
	}

	function getCloudX(cloud: Cloud, tSec: number, w: number): number {
		const span = w + cloud.scale * 6.5;
		return ((cloud.initX + cloud.speed * tSec) % span + span) % span - cloud.scale * 3.2;
	}

	// Returns 0 when cloud is invisible, up to cloud.maxAlpha when fully visible
	function getCloudAlpha(cloud: Cloud, tSec: number): number {
		const s = Math.sin((tSec / cloud.visPeriod) * Math.PI * 2 + cloud.visPhase);
		// Visible for roughly the top 60% of the sine wave; fade in/out over the shoulders
		const t = (s + 0.5) / 1.5; // [-0.5,1] → [0,1]
		return cloud.maxAlpha * Math.max(0, Math.min(1, t));
	}

	// Moon fades out every ~180 seconds and reappears after a longer dark gap
	function getMoonAlpha(tSec: number): number {
		const s = Math.sin(tSec / 180 * Math.PI * 2 + 0.8);
		const t = (s + 0.3) / 1.3; // threshold at -0.3 → dark gap at bottom of cycle
		return Math.max(0, Math.min(1, t));
	}

	function drawMoon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha = 1, haloAlpha = 1) {
		if (alpha <= 0.005) return;
		// Wide soft outer glow — fades when cloud cover is high
		const outerGlow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 5);
		outerGlow.addColorStop(0,   `rgba(255,248,210,${(0.14 * alpha * haloAlpha).toFixed(3)})`);
		outerGlow.addColorStop(0.35,`rgba(255,244,195,${(0.07 * alpha * haloAlpha).toFixed(3)})`);
		outerGlow.addColorStop(1,   'rgba(255,240,180,0)');
		ctx.beginPath();
		ctx.arc(x, y, r * 5, 0, Math.PI * 2);
		ctx.fillStyle = outerGlow;
		ctx.fill();
		// Inner halo — also fades with cloud cover
		const halo = ctx.createRadialGradient(x, y, r * 0.9, x, y, r * 2);
		halo.addColorStop(0, `rgba(255,250,215,${(0.14 * alpha * haloAlpha).toFixed(3)})`);
		halo.addColorStop(1, 'rgba(255,244,200,0)');
		ctx.beginPath();
		ctx.arc(x, y, r * 2, 0, Math.PI * 2);
		ctx.fillStyle = halo;
		ctx.fill();
		// Opaque backdrop — blocks stars from showing through the moon disc
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = 'rgb(12,14,20)';
		ctx.fill();
		// Moon disc with off-centre highlight to give it depth
		const disc = ctx.createRadialGradient(x - r * 0.22, y - r * 0.22, r * 0.08, x, y, r);
		disc.addColorStop(0,    `rgba(255,255,238,${(0.72 * alpha).toFixed(3)})`);
		disc.addColorStop(0.55, `rgba(252,248,218,${(0.62 * alpha).toFixed(3)})`);
		disc.addColorStop(0.85, `rgba(240,234,200,${(0.52 * alpha).toFixed(3)})`);
		disc.addColorStop(1,    `rgba(224,218,182,${(0.40 * alpha).toFixed(3)})`);
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = disc;
		ctx.fill();
	}

	function drawCloud(
		ctx: CanvasRenderingContext2D,
		cx: number, cy: number,
		scale: number, alpha: number,
		shapeIdx: number,
		stretchX = 1.0,
		tSec = 0
	) {
		if (alpha <= 0.005) return;
		ctx.save();
		ctx.shadowBlur = 0;

		if (shapeIdx === 2) {
			// Fluffy blob — solid dark grey fill, slowly morphing shape
			for (let i = 0; i < BLOB_SHAPE.length; i++) {
				const b = BLOB_SHAPE[i];
				// Each blob gets its own slow phase so they morph independently
				const p = tSec * 0.07 + i * 0.97;
				const dxMorph = Math.sin(p * 1.3) * 0.18;
				const rxMorph = 1 + Math.sin(p * 0.9 + 1.1) * 0.14;
				const ryMorph = 1 + Math.sin(p * 1.1 + 2.3) * 0.12;
				const bx = cx + (b.dx + dxMorph) * scale * stretchX;
				const by = cy + b.dy * scale;
				const rx = b.rx * scale * stretchX * rxMorph;
				const ry = b.ry * scale * ryMorph;
				ctx.beginPath();
				ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(42,50,72,${alpha.toFixed(3)})`;
				ctx.fill();
			}
		} else {
			// Wispy cirrus — solid dark grey ellipses, no outline
			const shape = WISP_SHAPES[shapeIdx];
			for (const w of shape) {
				const wx = cx + w.dx * scale * stretchX;
				const wy = cy + w.dy * scale;
				const rx = w.rx * scale * stretchX;
				const ry = w.ry * scale;
				const a  = alpha * w.a;
				ctx.beginPath();
				ctx.ellipse(wx, wy, rx, ry, 0, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(42,50,72,${a.toFixed(3)})`;
				ctx.fill();
			}
		}
		ctx.restore();
	}

	interface Star {
		x: number;
		y: number;
		radius: number;
		baseAlpha: number;
		twinkleSpeed: number;
		twinklePhase: number;
		isBright: boolean;
	}

	let stars: Star[] = [];

	function initStars(w: number, h: number) {
		// 88% tiny, 8% mid, 4% bright — heavily weighted toward small stars
		stars = Array.from({ length: 600 }, () => {
			const roll = Math.random();
			const isBright = roll < 0.04;
			const isMid    = roll < 0.12;
			const t = Math.random();
			return {
				x: Math.random() * w,
				y: Math.sqrt(t) * 110,
				radius: isBright ? 0.85 + Math.random() * 0.50
				       : isMid   ? 0.40 + Math.random() * 0.35
				                 : 0.10 + Math.random() * 0.22,
				baseAlpha: isBright ? 0.55 + Math.random() * 0.35
				          : isMid   ? 0.20 + Math.random() * 0.35
				                    : 0.08 + Math.random() * 0.28,
				twinkleSpeed: 0.2 + Math.random() * 0.9,
				twinklePhase: Math.random() * Math.PI * 2,
				isBright
			};
		});
	}

	function drawStars(ctx: CanvasRenderingContext2D, tMs: number) {
		const tSec = tMs / 1000;
		for (const s of stars) {
			const twinkle = Math.sin(tSec * s.twinkleSpeed + s.twinklePhase) * 0.65;
			const alpha = Math.max(0.03, Math.min(1, s.baseAlpha + twinkle));
			ctx.beginPath();
			ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
			ctx.fill();
			if (s.isBright) {
				ctx.beginPath();
				ctx.arc(s.x, s.y, s.radius * 3, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(210,235,255,${(alpha * 0.12).toFixed(3)})`;
				ctx.fill();
			}
		}
	}

	// Aurora phase cycle (ms):
	//     0 –  25000 : stars + clouds + moon only  (25s intro break)
	// Scene timeline (total 300s):
	// Scene 1 —   0– 30s : stars only break
	// Scene 2 —  30– 40s : aurora (green) fade in
	// Scene 3 —  40– 80s : aurora (green) hold
	// Scene 4 —  80– 90s : aurora (green) fade out
	// Scene 5 —  90– 50s : stars only break  [90–140]
	// Scene 6 — 140–155s : background clouds fade in
	// Scene 7 — 155–205s : clouds hold + moon fades in (moon in 155–170s)
	// Scene 8 — 205–215s : moon fades out
	// Scene 9 — 215–225s : clouds fade out
	// Scene 10— 225–300s : stars only break
	// 300s : loop
	const CYCLE = 300000;

	function getSceneState(tMs: number): {
		auroraAlpha: number;
		auroraColor: 'green' | 'blush' | null;
		cloudAlpha: number;
		moonAlpha: number;
	} {
		const p = tMs % CYCLE;
		// defaults
		let auroraAlpha = 0;
		let auroraColor: 'green' | 'blush' | null = null;
		let cloudAlpha = 0;
		let moonAlpha = 0;

		// Aurora scene
		if (p >= 30000 && p < 90000) {
			auroraColor = 'green';
			if      (p < 40000) auroraAlpha = (p - 30000) / 10000;
			else if (p < 80000) auroraAlpha = 1;
			else                auroraAlpha = 1 - (p - 80000) / 10000;
		}

		// Cloud scene
		if (p >= 140000 && p < 225000) {
			if      (p < 155000) cloudAlpha = (p - 140000) / 15000;       // fade in
			else if (p < 215000) cloudAlpha = 1;                           // hold
			else                 cloudAlpha = 1 - (p - 215000) / 10000;   // fade out
		}

		// Moon scene (subset of cloud scene)
		if (p >= 155000 && p < 215000) {
			if      (p < 170000) moonAlpha = (p - 155000) / 15000;        // fade in
			else if (p < 205000) moonAlpha = 1;                            // hold
			else                 moonAlpha = 1 - (p - 205000) / 10000;    // fade out
		}

		return { auroraAlpha, auroraColor, cloudAlpha, moonAlpha };
	}

	interface BandConfig {
		baseY: number;    // center of band as fraction of screen height
		height: number;   // band height as fraction of screen height
		waves: number;    // wave cycles across width
		speed: number;    // animation speed (radians/sec)
		phase0: number;   // initial phase offset
		amplitude: number;// wave amplitude as fraction of screen height
		maxAlpha: number; // this band's opacity contribution
	}

	const BANDS: BandConfig[] = [
		{ baseY: 0.13, height: 0.22, waves: 2.3, speed: 0.18, phase0: 0.0, amplitude: 0.05, maxAlpha: 0.16 },
		{ baseY: 0.07, height: 0.16, waves: 3.1, speed: 0.14, phase0: 1.4, amplitude: 0.04, maxAlpha: 0.12 },
		{ baseY: 0.20, height: 0.12, waves: 4.0, speed: 0.22, phase0: 2.7, amplitude: 0.03, maxAlpha: 0.09 },
		{ baseY: 0.04, height: 0.09, waves: 2.0, speed: 0.11, phase0: 0.7, amplitude: 0.04, maxAlpha: 0.07 }
	];

	const AURORA_COLORS: Record<'green' | 'blush', [number, number, number]> = {
		green: [30, 200, 95],
		blush: [225, 75, 165]
	};

	function drawAurora(
		ctx: CanvasRenderingContext2D,
		w: number,
		h: number,
		tSec: number,
		color: 'green' | 'blush',
		masterAlpha: number
	) {
		const [r, g, b] = AURORA_COLORS[color];
		const STEPS = 100;

		for (const band of BANDS) {
			const centerY = band.baseY * h;
			const halfH = (band.height * h) / 2;
			const amp = band.amplitude * h;

			// Build the top-edge wave points
			const topPts: [number, number][] = [];
			let minY = Infinity;
			for (let i = 0; i <= STEPS; i++) {
				const x = (i / STEPS) * w;
				const norm = i / STEPS;
				const wave =
					Math.sin(norm * Math.PI * band.waves + tSec * band.speed + band.phase0) +
					Math.sin(norm * Math.PI * band.waves * 1.65 + tSec * band.speed * 0.68 + band.phase0 + 1.1) * 0.38;
				const y = centerY - halfH + wave * amp;
				topPts.push([x, y]);
				if (y < minY) minY = y;
			}

			const bandH = band.height * h;

			ctx.save();
			ctx.beginPath();
			ctx.moveTo(topPts[0][0], topPts[0][1]);
			for (let i = 1; i <= STEPS; i++) ctx.lineTo(topPts[i][0], topPts[i][1]);
			// bottom edge (mirrored top + band height)
			for (let i = STEPS; i >= 0; i--) ctx.lineTo(topPts[i][0], topPts[i][1] + bandH);
			ctx.closePath();

			const grad = ctx.createLinearGradient(0, minY, 0, minY + bandH);
			const a = masterAlpha * band.maxAlpha;
			grad.addColorStop(0,    `rgba(${r},${g},${b},0)`);
			grad.addColorStop(0.22, `rgba(${r},${g},${b},${(a * 0.65).toFixed(3)})`);
			grad.addColorStop(0.5,  `rgba(${r},${g},${b},${a.toFixed(3)})`);
			grad.addColorStop(0.78, `rgba(${r},${g},${b},${(a * 0.5).toFixed(3)})`);
			grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);

			ctx.fillStyle = grad;
			ctx.fill();
			ctx.restore();
		}
	}

	function frame(tMs: number) {
		const ctx = canvas?.getContext('2d');
		if (!ctx) {
			raf = requestAnimationFrame(frame);
			return;
		}
		const w = canvas.width;
		const h = canvas.height;
		ctx.clearRect(0, 0, w, h);

		const tSec = tMs / 1000;

		drawStars(ctx, tMs);

		const { auroraAlpha, auroraColor, cloudAlpha, moonAlpha } = getSceneState(tMs);

		// Aurora scene
		if (auroraAlpha > 0.005 && auroraColor) {
			drawAurora(ctx, w, h, tSec, auroraColor, auroraAlpha);
		}

		// Moon scene — drawn before clouds so clouds naturally occlude it
		if (moonAlpha > 0.005) {
			// Compute moon cloud cover (0 = no cover, 1 = fully covered) for halo fade
			let moonCover = 0;
			for (const cloud of clouds) {
				if (!cloud.pinToMoon) continue;
				const period   = 180;
				const span     = w * 1.8;
				const cx       = (moonX - span * 0.5) + ((tSec * (span / period)) % span);
				const fadeZone = cloud.scale * 2.4 * 3.5;
				const dist     = Math.abs(cx - moonX);
				const t        = Math.max(0, Math.min(1, 1 - dist / fadeZone));
				moonCover      = t * t * (3 - 2 * t); // smoothstep
			}
			drawMoon(ctx, moonX, moonY, moonR, moonAlpha, moonAlpha * (1 - moonCover));
		}

		// Cloud scene — background clouds
		if (cloudAlpha > 0.005) {
			for (const cloud of clouds) {
				if (cloud.pinToMoon) continue; // drawn separately below
				const visAlpha = getCloudAlpha(cloud, tSec) * cloudAlpha;
				if (visAlpha <= 0.005) continue;
				const cx = getCloudX(cloud, tSec, w);
				drawCloud(ctx, cx, cloud.yFrac * h, cloud.scale, visAlpha, cloud.shapeIdx, cloud.stretchX ?? 1.0, tSec);
			}
		}

		// Moon cloud — only visible during moon scene, drifts left→right
		if (moonAlpha > 0.005) {
			for (const cloud of clouds) {
				if (!cloud.pinToMoon) continue;
				const period   = 180; // seconds per full pass
				const span     = w * 1.8;
				const cx       = (moonX - span * 0.5) + ((tSec * (span / period)) % span);
				const fadeZone = cloud.scale * 2.4 * 3.5;
				const dist     = Math.abs(cx - moonX);
				const t        = Math.max(0, Math.min(1, 1 - dist / fadeZone));
				const fade     = t * t * (3 - 2 * t); // smoothstep
				if (fade <= 0.005) continue;
				drawCloud(ctx, cx, moonY + moonR * 2.0, cloud.scale, cloud.maxAlpha * fade * moonAlpha, cloud.shapeIdx, 2.4, tSec);
			}
		}

		raf = requestAnimationFrame(frame);
	}

	function resize() {
		if (!canvas) return;
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		initStars(canvas.width, canvas.height);
		initClouds(canvas.width, canvas.height);
	}

	onMount(() => {
		if (Capacitor.isNativePlatform()) return;
		resize();
		window.addEventListener('resize', resize);
		raf = requestAnimationFrame(frame);
		return () => {
			window.removeEventListener('resize', resize);
			cancelAnimationFrame(raf);
		};
	});
</script>

<canvas
	bind:this={canvas}
	class="aurora-canvas"
></canvas>

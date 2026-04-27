import { useEffect, useRef } from "react";

interface WaveformProps {
  stream: MediaStream | null;
  isActive: boolean;
}

export function Waveform({ stream, isActive }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const levelRef = useRef(0);

  useEffect(() => {
    if (!stream || !isActive) {
      cancelAnimationFrame(animRef.current);
      drawEmpty();
      return;
    }

    const audioCtx = new AudioContext({ latencyHint: "interactive" });
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.fftSize);

    const draw = () => {
      animRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;
      
      // Use actual display dimensions
      const dpr = window.devicePixelRatio || 1;
      const displayWidth = canvas.clientWidth;
      const displayHeight = canvas.clientHeight;
      
      if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
        canvas.width = displayWidth * dpr;
        canvas.height = displayHeight * dpr;
        ctx.scale(dpr, dpr);
      }

      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, displayWidth, displayHeight);

      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }

      const rms = Math.sqrt(sumSquares / dataArray.length);
      const boostedLevel = Math.pow(Math.min(1, rms * 12.5), 0.54);
      const quietFloor = rms > 0.003 ? 0.14 : 0;
      const levelTarget = Math.max(quietFloor, boostedLevel);
      levelRef.current = levelRef.current * 0.44 + levelTarget * 0.56;

      const time = performance.now() / 420;
      const centerY = displayHeight / 2;
      const baseAmplitude = 0.7 + levelRef.current * displayHeight * 0.26;
      const lineConfigs = [
        { amplitude: 1.16, speed: 1.42, phase: 0.18, alpha: 0.3, width: 0.62, wobble: 0.9 },
        { amplitude: 0.92, speed: 0.81, phase: 1.7, alpha: 0.27, width: 0.58, wobble: 1.8 },
        { amplitude: 1.31, speed: 1.18, phase: 2.85, alpha: 0.24, width: 0.55, wobble: 1.2 },
        { amplitude: 0.78, speed: 1.67, phase: 4.1, alpha: 0.22, width: 0.52, wobble: 2.4 },
        { amplitude: 1.04, speed: 0.96, phase: 5.35, alpha: 0.2, width: 0.5, wobble: 1.5 },
        { amplitude: 0.68, speed: 1.92, phase: 0.9, alpha: 0.18, width: 0.48, wobble: 2.9 },
        { amplitude: 1.22, speed: 1.05, phase: 3.55, alpha: 0.16, width: 0.46, wobble: 2.1 },
        { amplitude: 0.84, speed: 1.74, phase: 2.25, alpha: 0.14, width: 0.44, wobble: 3.2 },
        { amplitude: 1.08, speed: 0.72, phase: 4.85, alpha: 0.13, width: 0.42, wobble: 1.1 },
        { amplitude: 0.56, speed: 2.15, phase: 1.28, alpha: 0.12, width: 0.4, wobble: 3.8 },
        { amplitude: 0.98, speed: 1.31, phase: 5.9, alpha: 0.11, width: 0.38, wobble: 2.6 },
        { amplitude: 0.72, speed: 1.58, phase: 3.08, alpha: 0.1, width: 0.36, wobble: 4.1 },
      ];

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      lineConfigs.forEach((line) => {
        ctx.beginPath();

          for (let x = 0; x <= displayWidth; x += 1.25) {
            const progress = x / displayWidth;
            const edgeFade = Math.sin(progress * Math.PI);
            const envelope = Math.pow(Math.max(0, edgeFade), 1.08);
            const drift = Math.sin(time * 0.37 + line.phase) * 0.18;
            const primary = Math.sin(progress * Math.PI * (3.1 + line.wobble * 0.18) + time * line.speed + line.phase);
            const secondary = Math.sin(progress * Math.PI * (7.3 + line.wobble * 0.42) - time * (line.speed * 0.83) + line.phase * 1.37);
            const tertiary = Math.cos(progress * Math.PI * (13.4 + line.wobble * 0.31) + time * (0.56 + line.wobble * 0.04) + line.phase);
            const grain = Math.sin((progress + line.phase) * 38 + time * (1.1 + line.wobble * 0.11)) * 0.055;
            const displacement = ((primary * 0.52) + (secondary * 0.31) + (tertiary * 0.12) + grain + drift) * baseAmplitude * line.amplitude * envelope;
            const y = centerY + displacement;

          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }

          ctx.strokeStyle = `rgba(0, 0, 0, ${line.alpha})`;
          ctx.lineWidth = line.width;
          ctx.shadowBlur = 0;
          ctx.stroke();
        });

      ctx.shadowBlur = 0;
    };

    void audioCtx.resume().catch(() => {});
    draw();

    return () => {
      cancelAnimationFrame(animRef.current);
      source.disconnect();
      audioCtx.close();
      levelRef.current = 0;
    };
  }, [stream, isActive]);

  function drawEmpty() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}

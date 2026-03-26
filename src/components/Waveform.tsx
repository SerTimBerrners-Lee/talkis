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
      const baseAmplitude = 1 + levelRef.current * displayHeight * 0.34;
      const lineConfigs = [
        { amplitude: 1.42, speed: 1, phase: 0, alpha: 0.36, width: 1.08 },
        { amplitude: 1.34, speed: 1.06, phase: Math.PI / 10, alpha: 0.33, width: 1.02 },
        { amplitude: 1.26, speed: 1.12, phase: Math.PI / 8, alpha: 0.3, width: 0.98 },
        { amplitude: 1.18, speed: 1.18, phase: Math.PI / 6.2, alpha: 0.28, width: 0.94 },
        { amplitude: 1.1, speed: 1.24, phase: Math.PI / 5.2, alpha: 0.25, width: 0.9 },
        { amplitude: 1.02, speed: 0.92, phase: Math.PI / 4.5, alpha: 0.23, width: 0.87 },
        { amplitude: 0.95, speed: 1.3, phase: Math.PI / 3.8, alpha: 0.21, width: 0.84 },
        { amplitude: 0.88, speed: 0.86, phase: Math.PI / 3.15, alpha: 0.19, width: 0.8 },
        { amplitude: 0.81, speed: 1.38, phase: Math.PI / 2.8, alpha: 0.17, width: 0.76 },
        { amplitude: 0.74, speed: 0.8, phase: Math.PI / 2.45, alpha: 0.15, width: 0.73 },
        { amplitude: 0.67, speed: 1.46, phase: Math.PI / 2.05, alpha: 0.14, width: 0.7 },
        { amplitude: 0.61, speed: 0.74, phase: Math.PI / 1.8, alpha: 0.13, width: 0.67 },
        { amplitude: 0.55, speed: 1.54, phase: Math.PI / 1.56, alpha: 0.12, width: 0.64 },
        { amplitude: 0.49, speed: 0.68, phase: Math.PI / 1.34, alpha: 0.11, width: 0.61 },
        { amplitude: 0.44, speed: 1.62, phase: Math.PI / 1.18, alpha: 0.1, width: 0.58 },
        { amplitude: 0.39, speed: 0.62, phase: Math.PI / 1.04, alpha: 0.09, width: 0.54 },
      ];

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      lineConfigs.forEach((line) => {
        ctx.beginPath();

          for (let x = 0; x <= displayWidth; x += 1) {
            const progress = x / displayWidth;
            const edgeFade = Math.sin(progress * Math.PI);
            const envelope = Math.pow(Math.max(0, edgeFade), 1.35);
            const primary = Math.sin(progress * Math.PI * 2.8 + time * line.speed + line.phase);
            const secondary = Math.sin(progress * Math.PI * 5.6 - time * (line.speed * 1.08) + line.phase * 0.72);
            const tertiary = Math.cos(progress * Math.PI * 8.2 + time * 0.74 + line.phase);
            const displacement = ((primary * 0.68) + (secondary * 0.22) + (tertiary * 0.1)) * baseAmplitude * line.amplitude * envelope;
            const y = centerY + displacement;

          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }

          ctx.strokeStyle = `rgba(0, 0, 0, ${line.alpha})`;
          ctx.lineWidth = line.width;
          ctx.shadowBlur = line.alpha > 0.28 ? 4 : 0;
          ctx.shadowColor = "rgba(0, 0, 0, 0.08)";
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

import type { PatternLayoutShape } from "../../shared/presentations";

const WIDTH = 1000;

/**
 * A layout drawn as boxes: what a deck fills is coloured by kind (text as lines, pictures,
 * tables, charts), and the rest of the design is grey. Not a picture of the slide: the app
 * has no renderer for PowerPoint, so this shows where things go and how much room they get.
 */
export function SlideWireframe({ aspectRatio, shapes, className, label }: {
  aspectRatio: number;
  shapes: PatternLayoutShape[];
  className?: string;
  label?: string;
}) {
  const height = WIDTH / (aspectRatio > 0 ? aspectRatio : 16 / 9);
  // A slide is 7.5 inches (540 pt) high in the common sizes, which turns font sizes into box units.
  const point = height / 540;
  return (
    <svg
      className={`slide-wireframe${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${WIDTH} ${Math.round(height)}`}
      role="img"
      aria-label={label ?? "Slide layout"}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect className="wire-slide" x={0} y={0} width={WIDTH} height={height} rx={10} />
      {shapes.map((shape, index) => {
        const x = shape.box.x * WIDTH;
        const y = shape.box.y * height;
        const w = shape.box.w * WIDTH;
        const h = shape.box.h * height;
        if (shape.fill === "line") {
          return <line key={index} className="wire-line" x1={x} y1={y} x2={x + w} y2={y + h} />;
        }
        if (shape.fill === "design") {
          return <rect key={index} className="wire-design" x={x} y={y} width={w} height={h} rx={4} />;
        }
        if (shape.fill === "text") {
          // Text is drawn as the lines its font size gives the box, at most six.
          const size = Math.min(Math.max((shape.fontSize ?? 14) * point, 9), Math.max(h * 0.8, 9));
          const lines = Math.max(1, Math.min(6, Math.floor(h / (size * 1.7))));
          const bar = size * 0.62;
          const gap = lines > 1 ? (h - bar) / (lines - 1) : 0;
          const heading = (shape.fontSize ?? 14) >= 24;
          return (
            <g key={index}>
              {Array.from({ length: lines }, (_, line) => (
                <rect
                  key={line}
                  className={heading ? "wire-heading" : "wire-text"}
                  x={x}
                  y={lines > 1 ? y + line * Math.min(gap, size * 1.7) : y + (h - bar) / 2}
                  width={line === lines - 1 && lines > 1 ? w * 0.62 : w}
                  height={bar}
                  rx={bar / 2}
                />
              ))}
            </g>
          );
        }
        return (
          <g key={index}>
            <rect className={`wire-${shape.fill}`} x={x} y={y} width={w} height={h} rx={6} />
            {shape.fill === "image" && w > 60 && h > 60 ? (
              <path className="wire-mark wire-mark-image" d={`M ${x + w * 0.2} ${y + h * 0.75} L ${x + w * 0.42} ${y + h * 0.42} L ${x + w * 0.58} ${y + h * 0.62} L ${x + w * 0.7} ${y + h * 0.5} L ${x + w * 0.82} ${y + h * 0.75} Z`} />
            ) : null}
            {shape.fill === "table" ? (
              <>
                {[0.25, 0.5, 0.75].map((row) => <line key={row} className="wire-rule" x1={x} y1={y + h * row} x2={x + w} y2={y + h * row} />)}
                {[0.33, 0.66].map((column) => <line key={column} className="wire-rule" x1={x + w * column} y1={y} x2={x + w * column} y2={y + h} />)}
              </>
            ) : null}
            {shape.fill === "chart" ? (
              <>
                {[0.35, 0.7, 0.5, 0.9].map((value, bar) => (
                  <rect key={bar} className="wire-mark wire-mark-chart" x={x + w * (0.12 + bar * 0.2)} y={y + h * (1 - value * 0.85) - h * 0.06} width={w * 0.13} height={h * value * 0.85} />
                ))}
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

'use client';

/** Thermal-paper tone shared by every ticket surface. */
export const PAPER = '#FDFCF7';

/**
 * Torn-paper edge. Top edge: paper sits low, teeth point up. Bottom edge
 * needs the inverse form (transparent-first) so the teeth point down;
 * swapping gradient angles alone is a no-op since the pair is mirrored.
 */
export function TornEdge({ bottom = false }: { bottom?: boolean }) {
  const teeth = bottom
    ? `linear-gradient(45deg, transparent 5px, ${PAPER} 0), linear-gradient(-45deg, transparent 5px, ${PAPER} 0)`
    : `linear-gradient(45deg, ${PAPER} 5px, transparent 0), linear-gradient(-45deg, ${PAPER} 5px, transparent 0)`;
  return (
    <div
      aria-hidden
      className="h-[10px] w-full shrink-0"
      style={{
        background: teeth,
        backgroundPosition: bottom ? 'left top' : 'left bottom',
        backgroundRepeat: 'repeat-x',
        backgroundSize: '10px 10px',
      }}
    />
  );
}

export function Rule({ dashed = false }: { dashed?: boolean }) {
  return (
    <div
      className={`my-3 border-t ${dashed ? 'border-dashed border-pixel-gray/70' : 'border-t-2 border-pixel-black'}`}
    />
  );
}

/**
 * Circular rubber-stamp chop: double ring, arced captions, status across the
 * middle, date below. Ink follows currentColor; a turbulence filter erodes
 * random specks so each ticket's chop reads as hand-stamped. Seed keeps the
 * wear pattern stable per task.
 */
export function CircularStamp({
  label,
  date,
  orderNo,
  seed,
}: {
  label: string;
  date: string;
  orderNo: string;
  seed: string;
}) {
  const seedNum = seed
    .split('')
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
  const uid = `chop-${seedNum}`;
  const status = label.toUpperCase();
  return (
    <svg
      width={110}
      height={110}
      viewBox="0 0 110 110"
      aria-hidden
      className="rotate-[-8deg]"
      style={{ fontFamily: 'var(--font-ticket)' }}
    >
      <defs>
        <filter id={uid} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed={seedNum} result="grain" />
          <feComponentTransfer in="grain" result="wear">
            <feFuncA type="linear" slope="8" intercept="-1" />
          </feComponentTransfer>
          <feComposite operator="in" in="SourceGraphic" in2="wear" />
        </filter>
        <path id={`${uid}-top`} d="M 17 55 A 38 38 0 0 1 93 55" />
        <path id={`${uid}-bot`} d="M 16 55 A 39 39 0 0 0 94 55" />
      </defs>
      <g filter={`url(#${uid})`} opacity="0.92" fill="currentColor">
        <circle cx="55" cy="55" r="52" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="55" cy="55" r="47.5" fill="none" stroke="currentColor" strokeWidth="1" />
        <text fontSize="8" letterSpacing="1.5">
          <textPath href={`#${uid}-top`} startOffset="50%" textAnchor="middle">
            LOXO * WORK ORDER
          </textPath>
        </text>
        <line x1="31" y1="45" x2="79" y2="45" stroke="currentColor" strokeWidth="1" />
        <text
          x="55"
          y={status.length > 8 ? 59 : 60}
          textAnchor="middle"
          fontWeight="bold"
          fontSize={status.length > 8 ? 11 : 14}
          letterSpacing="1"
        >
          {status}
        </text>
        <line x1="31" y1="64" x2="79" y2="64" stroke="currentColor" strokeWidth="1" />
        <text x="55" y="74" textAnchor="middle" fontSize="8" letterSpacing="1">
          {date}
        </text>
        <text fontSize="8" letterSpacing="1.5">
          <textPath href={`#${uid}-bot`} startOffset="50%" textAnchor="middle">
            {`* ${orderNo} *`}
          </textPath>
        </text>
      </g>
    </svg>
  );
}

export function BracketButton({
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  children: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`font-pixel text-xs uppercase tracking-wide disabled:opacity-40 ${
        danger ? 'text-pixel-red hover:bg-pixel-red' : 'text-pixel-black hover:bg-pixel-black'
      } px-1 hover:text-pixel-white disabled:hover:bg-transparent ${
        danger ? 'disabled:hover:text-pixel-red' : 'disabled:hover:text-pixel-black'
      }`}
    >
      [ {children} ]
    </button>
  );
}

// Orca MIT, pinned ea6a6d60774ac2b74bb6692d1798e3ab13b99ae0; original export copied unchanged.
import React from 'react'
export function OpenCodeIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // SVG geometry sourced from opencode.ai/favicon.svg's official 512 canvas.
  // Why: the branded fills are adapted to currentColor so the mark is visible
  // in both Orca themes, and keeping the square viewBox matches sibling glyphs.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="text-current"
    >
      <path d="M320 224V352H192V224H320Z" fill="currentColor" fillOpacity="0.28" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="currentColor"
      />
    </svg>
  )
}


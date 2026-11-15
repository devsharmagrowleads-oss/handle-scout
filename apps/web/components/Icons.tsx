const PATHS = {
  // state icons: each has a distinct silhouette, so state never depends on colour alone
  available: <path d="M3.5 8.5l3 3 6-7" />,
  taken: <path d="M4 4l8 8M12 4l-8 8" />,
  unknown: (
    <>
      <path d="M5.6 6a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8" />
      <path d="M8 12.6v.1" />
    </>
  ),
  invalid: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </>
  ),
  external: <path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5L7.5 8.5" />,
  download: <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5v-3h-8v8h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.2L14.3 13H1.7z" />
      <path d="M8 6.5v3M8 11.3v.1" />
    </>
  ),
  chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z" />,
  contrast: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11" />
      <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="icon spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
      <path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

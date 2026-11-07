export type IconName = "mic" | "mic-off" | "sound" | "arrow" | "camera" | "keyboard" | "check" | "settings" | "photo" | "send";

const paths: Record<IconName, React.ReactNode> = {
  mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></>,
  "mic-off": <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8M3 3l18 18" /></>,
  sound: <path d="m11 5-6 4H2v6h3l6 4ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  camera: <><path d="m8 6 2-3h4l2 3h4v14H4V6Z" /><circle cx="12" cy="12" r="3" /></>,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  photo: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
  send: <path d="m4 12 16-8-6 16-2-6-8-2Z" />,
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg className="icon" aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

/** The Mirror logo. Read as the plain word "mirror". */
export function Wordmark() {
  return <span className="wordmark"><span className="brand-symbol" aria-hidden="true"><span /><span /></span>mirror<span className="wordmark-dot" aria-hidden="true">.</span></span>;
}

import type { Metadata } from "next";
import { appPath } from "../lib/app-path";
import { SETTINGS_SCRIPT } from "../lib/client/settings";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mirror",
  description: "A mirror you can talk to or type to, for everyday grooming. Ask a question and get a little help with what is in view.",
  icons: { icon: appPath("/favicon.svg") },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The inline script applies saved display settings to <html> before first paint, so it differs from the server markup.
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: SETTINGS_SCRIPT }} /></head>
    <body>{children}</body>
  </html>;
}

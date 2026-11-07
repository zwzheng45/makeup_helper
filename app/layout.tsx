import type { Metadata } from "next";
import { appPath } from "../lib/app-path";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mirror — Your everyday care companion",
  description: "A voice-first mirror for everyday grooming. Ask a question, and get a little help with what is in view.",
  icons: { icon: appPath("/favicon.svg") },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}

import type { Metadata } from "next";
import { MirrorScreen } from "./mirror-screen";

export const metadata: Metadata = { title: "Mirror" };

export default function MirrorPage() {
  return <MirrorScreen />;
}

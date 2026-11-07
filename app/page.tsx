import type { Metadata } from "next";
import { SetupScreen } from "./setup-screen";

export const metadata: Metadata = { title: "Set up Mirror" };

export default function SetupPage() {
  return <SetupScreen />;
}

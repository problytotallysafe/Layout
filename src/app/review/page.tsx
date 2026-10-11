import LayoutAuthGate from "@/components/layout-auth-gate";
import { LayoutPlanner } from "@/components/layout-planner";

export default function ReviewPage() {
  if (process.env.VERCEL_ENV !== "preview") return <LayoutAuthGate />;
  return <LayoutPlanner previewOnly />;
}

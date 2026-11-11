"use client";

// Guard for pages that only exist in Advanced view (Status, Console,
// Config). In Simple view the page is not rendered at all - so its own
// hooks never run - and a short notice offers the way in instead.
import { Button, Card } from "@heroui/react";
import { Eye } from "lucide-react";
import { useViewLevel } from "@/app/components/ViewLevelProvider";
import { useUISound } from "@/app/hooks/useUISound";

export default function AdvancedOnly({
  name,
  what,
  children,
}: {
  /** Page name, e.g. "Console". */
  name: string;
  /** One sentence: what the page is for. */
  what: string;
  children: React.ReactNode;
}) {
  const { level, setLevel } = useViewLevel();
  const { play } = useUISound();

  if (level === "advanced") return <>{children}</>;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <Card className="p-6" data-testid="advanced-only-notice">
        <Card.Header className="flex-col items-start gap-1">
          <div className="flex items-center gap-2">
            <Eye size={16} className="text-accent" />
            <Card.Title>{name} is in Advanced view</Card.Title>
          </div>
          <Card.Description>{what}</Card.Description>
        </Card.Header>
        <Card.Content className="mt-4 flex flex-col items-start gap-3">
          <p className="text-sm text-muted">
            You do not need it to run a server with friends. Switching only
            changes what MineUI shows. Your servers stay exactly as they are.
          </p>
          <Button
            variant="primary"
            onPress={() => {
              play("toggle_on");
              setLevel("advanced");
            }}
          >
            Show Advanced
          </Button>
        </Card.Content>
      </Card>
    </main>
  );
}

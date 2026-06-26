import { useState } from "react";
import { useStore } from "./store";
import { ProfileGate } from "./components/ProfileGate";
import { LoginGate } from "./components/LoginGate";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Explore } from "./components/Explore";
import type { ExploreTab } from "./components/Explore";
import { ReminderAlerts } from "./components/ReminderAlerts";

export function App() {
  const { activeProfile, status, error, authStatus } = useStore();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [mainView, setMainView] = useState<"explore" | "chat">("explore");
  const [exploreTab, setExploreTab] = useState<ExploreTab>("calendar");
  const [pipelineConvId, setPipelineConvId] = useState<string | null>(null);
  // Where to return when leaving a conversation (the screen we came from).
  const [returnTo, setReturnTo] = useState<"explore" | null>("explore");

  const openConversation = (id: string | null) => {
    setReturnTo(mainView === "explore" ? "explore" : returnTo);
    setActiveConversationId(id);
    setMainView("chat");
  };

  // Trace a conversation in the pipeline view (from the sidebar's row action).
  const showInPipeline = (id: string) => {
    setPipelineConvId(id);
    setExploreTab("pipeline");
    setMainView("explore");
  };

  if (status === "loading") {
    return (
      <div className="boot">
        <div className="boot-mark">◆</div>
        <p>Connecting to your gateway…</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="boot">
        <div className="boot-mark">◆</div>
        <h2>Can't reach the backend</h2>
        <p className="boot-error">{error}</p>
        <p className="boot-hint">
          Start it with <code>npm run dev</code> in{" "}
          <code>personal-claude/backend</code>, then reload.
        </p>
      </div>
    );
  }

  if (authStatus === "out") {
    return <LoginGate />;
  }

  if (!activeProfile) {
    return <ProfileGate />;
  }

  return (
    <div
      className="app"
      style={{ ["--accent" as string]: activeProfile.color }}
    >
      <Sidebar
        activeConversationId={mainView === "chat" ? activeConversationId : null}
        exploring={mainView === "explore"}
        onSelectConversation={openConversation}
        onExplore={() => setMainView("explore")}
        inPipeline={mainView === "explore" && exploreTab === "pipeline"}
        onShowInPipeline={showInPipeline}
      />
      {mainView === "explore" ? (
        <Explore
          onOpenChat={openConversation}
          tab={exploreTab}
          onTabChange={setExploreTab}
          pipelineConvId={pipelineConvId}
          onPipelineSelect={setPipelineConvId}
        />
      ) : (
        <ChatView
          key={activeConversationId ?? "empty"}
          conversationId={activeConversationId}
          onConversationCreated={openConversation}
          onBack={returnTo === "explore" ? () => setMainView("explore") : undefined}
        />
      )}
      <ReminderAlerts />
    </div>
  );
}

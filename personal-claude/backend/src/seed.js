// Initial data, inserted once when a fresh DB is created. Mirrors the frontend
// mock so the app looks identical whether or not the backend is running.

export const SEED_PROFILES = [
  {
    id: "p-lior",
    name: "Lior",
    tagline: "Founder · product & research",
    persona:
      "You are a sharp, concise thinking partner. Prefer structured answers, surface tradeoffs, and challenge weak assumptions.",
    avatar: "🦊",
    color: "#D97757",
    default_model: "claude-opus-4-8",
    budget_usd: 50,
    spent_usd: 18.42,
    google: null,
  },
  {
    id: "p-maya",
    name: "Maya",
    tagline: "Design · brand & UX",
    persona:
      "You are a warm, visual collaborator. Think in terms of user flows, give concrete UI suggestions, and keep language friendly.",
    avatar: "🎨",
    color: "#7C6FF0",
    default_model: "gemini-2.5-pro",
    budget_usd: 40,
    spent_usd: 6.1,
    google: null,
  },
  {
    id: "p-dev",
    name: "Dev",
    tagline: "Engineering · backend & infra",
    persona:
      "You are a pragmatic senior engineer. Give working code, name tradeoffs, and prefer simple, well-tested solutions.",
    avatar: "🛠️",
    color: "#3BA776",
    default_model: "claude-sonnet-4-6",
    budget_usd: 60,
    spent_usd: 31.77,
    google: null,
  },
];

const h = 3_600_000;
const d = 86_400_000;

/** Build seed conversations/notes/reminders for one profile. */
export function buildSeedForProfile(profileId, now) {
  const all = {
    "p-lior": {
      conversations: [
        {
          id: "c-1",
          title: "RAV4 financing vs. leasing",
          created_at: now - 4 * d,
          updated_at: now - 2 * h,
          model: "claude-opus-4-8",
          pinned: 1,
          concepts: ["RAV4", "financing", "leasing", "BC", "interest rates"],
          messages: [
            {
              id: "m-1",
              role: "user",
              content: "Should I finance or lease a 2024 RAV4 LE in BC?",
              ts: now - 4 * d,
            },
            {
              id: "m-2",
              role: "assistant",
              content:
                "It depends on how long you keep cars. **Financing** wins if you hold 6+ years; **leasing** suits 3-year cycles with lower monthly cost. Want me to run the BC numbers?",
              ts: now - 4 * d + 60_000,
              model: "claude-opus-4-8",
            },
          ],
        },
        {
          id: "c-2",
          title: "Knowledge-graph schema for chats",
          created_at: now - 1 * d,
          updated_at: now - 30 * 60_000,
          model: "claude-opus-4-8",
          pinned: 0,
          concepts: ["knowledge graph", "pgvector", "concepts", "sessions"],
          messages: [
            {
              id: "m-3",
              role: "user",
              content: "How should I model concepts linking across sessions?",
              ts: now - 1 * d,
            },
            {
              id: "m-4",
              role: "assistant",
              content:
                "Use a `concepts` table (canonical node + embedding) and a `session_concepts` edge table. Two-hop traversal finds related sessions; add cosine similarity for fuzzy bridges.",
              ts: now - 1 * d + 90_000,
              model: "claude-opus-4-8",
            },
          ],
        },
      ],
      notes: [
        {
          id: "n-1",
          conversation_id: "c-1",
          title: "Car decision rule",
          body: "**Finance** if holding 6+ yrs. Re-check BC interest rates before signing.",
          created_at: now - 4 * d,
          updated_at: now - 2 * h,
        },
        {
          id: "n-2",
          conversation_id: "c-2",
          title: "KG schema",
          body: "`concepts` (node + embedding) + `session_concepts` (edges). Two-hop + cosine for related sessions.",
          created_at: now - 1 * d,
          updated_at: now - 1 * d,
        },
      ],
      reminders: [
        {
          id: "r-1",
          text: "Compare BC car insurance quotes",
          due_at: now + 2 * d,
          done: 0,
          conversation_id: "c-1",
        },
        {
          id: "r-2",
          text: "Draft pgvector migration",
          due_at: now + 5 * h,
          done: 0,
          conversation_id: "c-2",
        },
      ],
    },
    "p-maya": {
      conversations: [
        {
          id: "c-3",
          title: "Onboarding flow polish",
          created_at: now - 3 * d,
          updated_at: now - 5 * h,
          model: "gemini-2.5-pro",
          pinned: 0,
          concepts: ["onboarding", "UX", "empty states"],
          messages: [
            {
              id: "m-5",
              role: "user",
              content: "Ideas to make the empty profile state feel welcoming?",
              ts: now - 3 * d,
            },
            {
              id: "m-6",
              role: "assistant",
              content:
                "Lead with a friendly illustration, one primary CTA ('Start your first chat'), and a 2-line value prompt. Avoid more than one action above the fold.",
              ts: now - 3 * d + 45_000,
              model: "gemini-2.5-pro",
            },
          ],
        },
      ],
      notes: [],
      reminders: [
        {
          id: "r-4",
          text: "Send onboarding mockups",
          due_at: now + 1 * d,
          done: 1,
          conversation_id: null,
        },
      ],
    },
    "p-dev": {
      conversations: [
        {
          id: "c-4",
          title: "LiteLLM per-user budgets",
          created_at: now - 6 * h,
          updated_at: now - 1 * h,
          model: "claude-sonnet-4-6",
          pinned: 1,
          concepts: ["LiteLLM", "budgets", "rate limits", "gateway"],
          messages: [
            {
              id: "m-7",
              role: "user",
              content: "How do I cap spend per profile in LiteLLM?",
              ts: now - 6 * h,
            },
            {
              id: "m-8",
              role: "assistant",
              content:
                "Pass each profile as the `user` field and set `max_end_user_budget`. Enable `fail_closed_budget_enforcement: true` for hard ceilings.",
              ts: now - 6 * h + 30_000,
              model: "claude-sonnet-4-6",
            },
          ],
        },
      ],
      notes: [
        {
          id: "n-3",
          conversation_id: null,
          title: "Gateway checklist",
          body: "- one upstream key in proxy\n- tag profile as `user`\n- hard budget caps on",
          created_at: now - 5 * h,
          updated_at: now - 5 * h,
        },
      ],
      reminders: [
        {
          id: "r-3",
          text: "Set fail_closed budget enforcement",
          due_at: now - 1 * h,
          done: 0,
          conversation_id: null,
        },
      ],
    },
  };
  return all[profileId] ?? { conversations: [], notes: [], reminders: [] };
}

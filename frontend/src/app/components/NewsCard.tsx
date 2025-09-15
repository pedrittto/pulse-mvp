export type BreakingItem = {
  id: string;
  source: string;
  title: string;
  url: string;
  published_at_ms?: number;
  visible_at_ms: number;
};

export type NewsCardProps = {
  item: BreakingItem;
  priorityMatch: boolean;
};

function timeAgo(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export function NewsCard({ item, priorityMatch }: NewsCardProps) {
  const badgeStyle: React.CSSProperties = {
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: 4,
    background: "#eee",
    color: "#333",
    fontSize: 12,
    marginRight: 8,
  };

  const priorityStyle: React.CSSProperties = {
    ...badgeStyle,
    background: "#ffe7cc",
    color: "#8a4b00",
  };

  const cardStyle: React.CSSProperties = {
    border: "1px solid #ddd",
    borderRadius: 6,
    padding: 12,
    marginBottom: 10,
    background: "#fff",
  };

  const titleStyle: React.CSSProperties = {
    fontWeight: 600,
    lineHeight: 1.3,
  };

  return (
    <article style={cardStyle}>
      <div style={{ marginBottom: 6 }}>
        <span style={badgeStyle}>{item.source}</span>
        {priorityMatch && <span style={priorityStyle}>Priority</span>}
      </div>
      <div style={{ marginBottom: 4 }}>
        <a href={item.url} target="_blank" rel="noreferrer" style={titleStyle}>
          {item.title}
        </a>
      </div>
      <div style={{ fontSize: 12, color: "#666" }}>
        {typeof item.visible_at_ms === "number" ? timeAgo(item.visible_at_ms) : ""}
      </div>
    </article>
  );
}

export default NewsCard;



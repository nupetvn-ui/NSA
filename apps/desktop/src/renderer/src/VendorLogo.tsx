import claudeSpark from './brand/claude-spark.svg';
import kimiDark from './brand/kimi-logomark-dark.svg';
import kimiLight from './brand/kimi-logomark-light.svg';
import lmStudio from './brand/lm-studio-icon.svg';
import openRouter from './brand/openrouter-glyph.svg';
import together from './brand/together-icon.svg';

/**
 * Logo chính thức của hãng đứng cạnh tên agent / nhà cung cấp — file gốc, KHÔNG sửa (xem brand/README.md).
 * Hãng nào chưa lấy được bản logo chính thức thì hiện ô chữ cái trung tính (không vẽ lại gần giống logo).
 */
const LOGOS: Record<string, { src: string; darkSrc?: string }> = {
  anthropic: { src: claudeSpark },
  openrouter: { src: openRouter },
  lmstudio: { src: lmStudio },
  together: { src: together },
  // Kimi: ô vuông bo góc; giao diện sáng dùng bản nền đen, giao diện tối dùng bản nền trắng.
  kimi: { src: kimiLight, darkSrc: kimiDark },
};

const AGENT_VENDOR: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
  opencode: 'opencode',
};

/** Mã hãng của một agent (`claude` = Claude Code; `api:<hãng>/<model>` = gọi thẳng qua API key). */
export function vendorOfAgent(agentId: string): string | null {
  const known = AGENT_VENDOR[agentId];
  if (known) return known;
  const m = /^api:([^/]+)\//.exec(agentId);
  return m?.[1] ?? null;
}

export function VendorLogo({
  vendor,
  name,
  size = 14,
}: {
  vendor: string | null;
  /** Tên hiển thị — chỉ để lấy chữ cái cho ô trung tính khi chưa có logo chính thức. */
  name?: string;
  size?: number;
}) {
  if (!vendor) return null;
  const logo = LOGOS[vendor];
  if (!logo) {
    const letter = (name ?? vendor).trim().charAt(0).toUpperCase() || '?';
    return (
      <span
        className="vendor-logo vendor-mono"
        style={{ width: size, height: size, fontSize: size * 0.62 }}
        aria-hidden="true"
      >
        {letter}
      </span>
    );
  }
  return (
    <picture className="vendor-logo-pic" aria-hidden="true">
      {logo.darkSrc && <source media="(prefers-color-scheme: dark)" srcSet={logo.darkSrc} />}
      <img
        src={logo.src}
        alt=""
        width={size}
        height={size}
        className="vendor-logo"
        draggable={false}
      />
    </picture>
  );
}

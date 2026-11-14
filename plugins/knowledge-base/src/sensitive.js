// Phát hiện thông tin nhạy cảm trong tài liệu: số thẻ, CCCD, mật khẩu, khoá API, khoá riêng.
// Mục chứa các thứ này KHÔNG bao giờ được tự nhận (luôn chờ người duyệt) và có cảnh báo.

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const RULES = [
  {
    what: 'số thẻ thanh toán',
    re: /\b(?:\d[ -]?){13,19}\b/g,
    test: (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  { what: 'số CCCD / CMND', re: /(?<![\d.,])(?:0\d{11}|\d{9})(?![\d.,])/g, test: () => true },
  {
    what: 'mật khẩu',
    re: /(?:mật khẩu|mat khau|password|passwd|pwd|passcode)\s*(?:là|la|:|=|-)\s*\S+/gi,
    test: () => true,
  },
  {
    what: 'khoá API / token',
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[\w-]{10,}|AIza[\w-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g,
    test: () => true,
  },
  {
    what: 'khoá bí mật',
    re: /\b(?:api[ _-]?key|secret|token|bearer)\b\s*[:=]\s*\S{8,}/gi,
    test: () => true,
  },
  { what: 'khoá riêng (private key)', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, test: () => true },
  {
    what: 'số tài khoản ngân hàng',
    re: /(?:stk|số tài khoản|so tai khoan|account (?:no|number))\s*[:.-]?\s*\d[\d ]{7,18}\d/gi,
    test: () => true,
  },
];

/** Trả về danh sách loại nhạy cảm tìm thấy (không lặp). Rỗng = không thấy gì. */
export function detectSensitive(text) {
  const found = new Set();
  const s = String(text ?? '');
  for (const rule of RULES) {
    for (const m of s.matchAll(rule.re)) {
      if (rule.test(m[0])) {
        found.add(rule.what);
        break;
      }
    }
  }
  return [...found];
}

/** Che các đoạn nhạy cảm: giữ 4 ký tự cuối để còn nhận ra, phần còn lại thành ●. */
export function maskSensitive(text) {
  let out = String(text ?? '');
  for (const rule of RULES) {
    out = out.replace(rule.re, (m) => {
      if (!rule.test(m)) return m;
      if (rule.what === 'khoá riêng (private key)') return '[đã che khoá riêng]';
      const core = m.trimEnd();
      const rest = m.slice(core.length);
      const tail = core.slice(-4);
      return `●●●●${/^[\w-]+$/.test(tail) ? tail : ''}${rest}`;
    });
  }
  return out;
}

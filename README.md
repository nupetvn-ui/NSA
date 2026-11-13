# NSA

App desktop điều phối nhiều agent AI chạy qua CLI (Claude Code, Codex, OpenCode, Gemini CLI…), kèm App Store công cụ cài thêm và bộ nhớ riêng tự học, tự duyệt.

Ba trụ cột:

- **Điều phối** — mỗi CLI là một adapter rời, nhà cung cấp update thì chỉ cần cập nhật adapter.
- **NSA Mem** — bộ nhớ nằm trên máy người dùng, agent nào cũng dùng chung; dạy bằng văn bản, ảnh, video và lịch sử chat.
- **App Store** — plugin theo chuẩn MCP: Zalo, Telegram, Discord, Knowledge Base, Hẹn giờ, tự động hoá trình duyệt, Content Factory.

Kế hoạch tổng thể: [docs/PLAN.md](docs/PLAN.md) · Quyết định kỹ thuật: [docs/adr/](docs/adr/README.md)

Trạng thái: **giai đoạn 4 (Kênh chat)** — Telegram, Discord, Lark Suite, Zalo OA và Zalo cá nhân (không chính thức) là plugin; token cất trong kho khoá của Windows và plugin không đọc được; nhớ theo nhóm / nick; canh nhóm theo lô; bot trả lời theo nội quy từng nhóm. Đã chạy thật trong app (dev + bản đóng gói) nhưng với **máy chủ giả**: **chưa thử với token / tài khoản thật nào** — xem [ADR-0011](docs/adr/0011-kenh-chat-plugin-khe-bi-mat-va-canh-nhom-theo-lo.md). Giai đoạn 3 (App Store) — plugin cài / bật / tắt / gỡ không cần khởi động lại, mỗi plugin một tiến trình riêng chỉ dùng quyền được cấp, gói có chữ ký, một cổng MCP chung đưa tool của plugin và bộ nhớ cho agent (đi qua chính sách + nhật ký). Đã chạy thật với Claude Code và OpenCode, cả bản đóng gói — xem [ADR-0010](docs/adr/0010-app-store-plugin-host-va-cong-mcp.md) (kể cả giới hạn của cách cô lập). Giai đoạn 2 (NSA Mem) — bộ nhớ dùng chung cho mọi agent: dạy một agent, agent khác hãng nhớ (đã chạy thật với Claude Code, Codex, OpenCode, cả trong bản đóng gói). Giai đoạn 1 (Điều phối) — chat với Claude Code, Codex, OpenCode (đã chạy thật), Gemini CLI và Antigravity (viết theo tài liệu, chưa chạy thật) hoặc CLI bất kỳ qua tầng PTY, trong cùng một app. Đổi agent giữa chừng vẫn giữ ngữ cảnh. Agent hỏng thì NSA tự lùi tầng hoặc đổi agent. Lệnh nguy hiểm bên trong một lượt bị chặn hoặc phải hỏi (Claude Code, OpenCode). Nền: monorepo, đóng gói Windows, tự cập nhật, CI, test hợp đồng hằng đêm.

**Giai đoạn 1b (API key)** — dán API key của một hãng (Google AI Studio, DeepSeek, OpenAI, Anthropic, xAI, Qwen, Kimi, GLM, MiniMax, OpenRouter, Groq, Together, Fireworks) hoặc dùng Ollama / LM Studio trên máy là chat được; mỗi loại việc có model chính + dự phòng, việc nền mặc định dùng model rẻ; hãng lỗi thì tự chuyển model dự phòng; theo dõi chi phí và hạn mức tháng. Key cất trong kho khoá của Windows. Mới chạy với máy chủ giả, **chưa chạy với hãng thật** — xem [ADR-0009](docs/adr/0009-nguon-model-qua-api-key.md).

## Dùng NSA

1. Cài CLI của agent muốn dùng (một lần), rồi đăng nhập từng cái:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai
```

```bash
claude auth login
```

```bash
codex login
```

OpenCode dùng được ngay với model miễn phí của OpenCode Zen (cần bản 1.18 trở lên); muốn dùng khoá riêng thì chạy `opencode auth login`. Gemini CLI (`npm install -g @google/gemini-cli`) và Antigravity CLI (`agy`, cài theo antigravity.google/docs/cli) cũng được hỗ trợ.

2. Mở NSA, bấm biểu tượng soạn tin ở thanh bên, chọn thư mục dự án và bật/tắt **Cho sửa file** (tắt = agent chỉ đọc và lập kế hoạch).
3. Chọn agent ngay trên ô nhập (hoặc **Tự chọn** để NSA chọn agent đủ năng lực), gõ yêu cầu, Enter để gửi. Lượt sau có thể đổi agent — agent mới nhận tóm tắt những gì agent trước đã làm.
4. Góc dưới thanh bên cho biết agent nào đã cài / đã đăng nhập, phiên bản, tầng giao tiếp và năng lực (bấm vào tên để xem); bấm **Kiểm lại** sau khi cài hoặc đăng nhập. Khi một CLI vừa cập nhật (đổi phiên bản hoặc `--help`), NSA báo ở đây.
5. Agent được chọn hỏng hoặc chưa cài: NSA tự lùi xuống tầng văn bản thô / PTY hoặc chuyển sang agent khác, và ghi rõ trong lượt trả lời.
6. Khi agent định chạy lệnh rủi ro (`git push`, `npm publish`…), lượt dừng lại và hiện **Cho phép / Từ chối**. Lệnh phá huỷ hiển nhiên (`rm -rf /`, định dạng ổ đĩa…) luôn bị chặn. Hiện áp dụng cho Claude Code và OpenCode — xem [ADR-0007](docs/adr/0007-chan-tung-lenh-qua-cong-chinh-sach.md).

7. **Dùng API key** (không cần CLI): bấm **Nhà cung cấp (API key)** ở thanh bên → chọn hãng → dán key vào ô **Dán key** → **Lưu** → **Kiểm tra**. Model của hãng xuất hiện ngay trong danh sách agent trên ô nhập. Mỗi hãng ghi rõ dữ liệu gửi đi đâu (nơi đặt máy chủ, có dùng để huấn luyện không, gói miễn phí hay trả tiền) kèm link tài liệu gốc. Không bao giờ dán key vào khung chat.
   - Thẻ **Model theo việc**: chọn model chính + dự phòng cho việc chính, việc nền, nhìn ảnh, embedding, kênh chat; bấm **Chạy thử** để xem model nào nhận việc.
   - Thẻ **Chi phí**: số token và chi phí ước tính theo model trong tháng, đặt hạn mức tháng; NSA cảnh báo khi gần chạm và (nếu bật) chặn model trả phí khi vượt.
   - Mục **Dùng key này cho CLI có sẵn**: chạy OpenCode / Claude Code bằng key của hãng (theo từng lượt, không sửa cấu hình CLI). Model chưa được đánh dấu gọi tool ổn định thì CLI chỉ được đọc.
   - Hãng khác chưa có trong danh sách: **+ Thêm hãng khác…** (địa chỉ chuẩn OpenAI hoặc Anthropic + tên model).

### App Store (plugin)

Bấm **App Store** ở thanh bên: lưới các app đã bật (bấm để mở màn hình của app); **Quản lý** ở góc để bật/tắt/gỡ, xem và thu hồi quyền, cài từ gói `.nsapkg` hoặc từ kho (file chỉ mục). Khi cài, hộp xin quyền liệt kê từng quyền plugin xin — bỏ chọn quyền nào thì plugin không có quyền đó. Plugin chưa ký chỉ cài được khi bật **Chế độ nhà phát triển** (kèm cảnh báo); gói bị sửa sau khi ký luôn bị từ chối. Agent (Claude Code, Codex, OpenCode) gọi tool của plugin qua cổng MCP `nsa`; thao tác plugin đánh dấu nhạy cảm luôn hỏi bạn. Viết plugin: [docs/viet-plugin-dau-tien.md](docs/viet-plugin-dau-tien.md). **Chưa có**: kho trực tuyến và thanh toán (giai đoạn 8), cô lập ở mức hệ điều hành (AppContainer).

### Kênh chat (Telegram, Discord, Zalo)

Cài từ **App Store → Quản lý → Cài từ thư mục…** (bật Chế độ nhà phát triển) chọn `plugins/telegram`, `plugins/discord`, `plugins/lark` (Lark Suite), `plugins/zalo-oa` hoặc `plugins/zalo-ca-nhan`. Mỗi kênh:

1. **Nhập token** ở Quản lý → tên kênh → mục **Bí mật** (hướng dẫn lấy token ở màn hình của kênh). Token cất trong kho khoá của hệ điều hành; plugin KHÔNG đọc được, chỉ nhờ NSA điền vào lời gọi tới đúng máy chủ của kênh. Nhớ bật quyền **model** (bot dùng model rẻ của việc "kênh chat" ở màn hình Nhà cung cấp; nội dung tin nhắn đi tới nhà cung cấp đó).
2. Mở màn hình kênh: nhóm bot thấy hiện trong **Nhóm**, mặc định **Tắt** (không lưu tin, không gọi model). Chọn **Canh** (ghi vi phạm, không gửi) hoặc **Trả lời đúng nội quy**.
3. Viết **nội quy** từng nhóm (và quy tắc chung / theo nick): nội quy là mục nhớ nên vào **Bộ nhớ → Hộp duyệt** chờ bạn duyệt — để người lạ trong nhóm không dạy được bot. Nút **Bot sẽ nói gì?** thử trả lời không gửi.
4. Bot gom tin theo lô (mỗi nhóm một lần gọi model cho cả lô, không gọi từng tin). Gửi / xoá / mời ra / gửi hàng loạt / đổi trưởng nhóm đều qua chính sách + nhật ký; thao tác nhạy cảm luôn hỏi bạn.

**Zalo cá nhân là API không chính thức** — có thể bị khoá nick, vi phạm điều khoản Zalo; chỉ có ở bản Cá nhân và phải xác nhận cảnh báo khi cài; cần một "cầu nối" tự chọn chạy trên máy (xem `plugins/zalo-ca-nhan/BRIDGE.md`), NSA không đi kèm. Zalo OA là kênh chính thức. **Chưa chạy thật với Telegram / Discord / Lark / Zalo thật.**

### Bộ nhớ (NSA Mem)

Bấm **Bộ nhớ** ở thanh bên (số bên cạnh là đề xuất đang chờ duyệt).

- **Dạy**: bấm **Dạy điều mới** và gõ bằng văn bản; hoặc dặn agent khi chat ("hãy nhớ…", "từ nay…") — agent hỗ trợ MCP (Claude Code, Codex, OpenCode) tự đề xuất qua tool `mem_propose`, đồng thời NSA giao một agent chắt lọc đoạn chat. Nút **Ghi nhớ cuộc trò chuyện** ở đầu khung chat chắt lọc ngay.
- **Hộp duyệt**: điều chắc chắn, không mâu thuẫn được tự nhận theo quy tắc của nhánh. Quy tắc hành vi, thông tin nhạy cảm, độ tin cậy thấp hoặc **mâu thuẫn** với mục đã có thì chờ bạn: **Nhận**, **Sửa rồi nhận**, **Nhận, thay mục cũ** hoặc **Từ chối**.
- **Dùng**: đầu mỗi lượt chat, NSA chèn các mục liên quan cho agent (lượt đó hiện "dùng N mục nhớ"); mục nhạy cảm không tự chèn.
- **Hoàn tác**: mỗi thay đổi có trong **Lịch sử** (của cả kho và của từng mục), bấm **Hoàn tác** để trả về như cũ.
- **Nhập lịch sử chat**: chọn nguồn (NSA, Claude Code, Codex, OpenCode), xem trước, tích các phiên rồi bấm **Nhập**. Không đọc gì khi chưa bấm.
- **Cài đặt**: bật/tắt tự chèn, tool `mem_*`, ngưỡng tự chắt lọc, agent chắt lọc; nút **Dựng lại** chỉ mục.

Mỗi mục nhớ là một file Markdown trong thư mục `%APPDATA%\NSA\memory` (mỗi nhánh một thư mục con, mở được bằng trình soạn thảo bất kỳ), có lịch sử git riêng trong thư mục đó. Chỉ mục tìm kiếm (`memory\.nsa\index.sqlite`) xoá đi thì NSA tự dựng lại. Hiện chỉ tìm theo từ khoá (gõ không dấu vẫn được), **chưa có tìm theo nghĩa**. Chi tiết: [ADR-0008](docs/adr/0008-nsa-mem.md).

CLI chưa có adapter riêng: khai báo trong `%APPDATA%\NSA\custom-clis.json`, ví dụ `[{"id":"aider","displayName":"Aider","command":"aider","args":["--yes","--message-file","-"],"input":"stdin"}]`, rồi mở lại NSA.

Cuộc trò chuyện được lưu ở `%APPDATA%\NSA\conversations.json`, nhật ký (ai ra lệnh, chính sách quyết gì, agent làm gì, lùi tầng / đổi agent) ở `%APPDATA%\NSA\audit\`. Key mã hoá ở `secrets.json`, cài đặt nhà cung cấp (không có key) ở `providers.json`, sổ chi phí ở `usage\`. Bản cập nhật danh sách hãng/model đặt ở `provider-catalog.json` (NSA dùng nếu mới hơn bản kèm app).

## Cài đặt môi trường (cho lập trình viên)

Cần:

- **Node.js 24** (phiên bản ghim trong [`.nvmrc`](.nvmrc))
- **pnpm 10** — bật qua corepack đi kèm Node:

```bash
corepack enable
```

Cài thư viện (lần đầu, từ thư mục gốc repo):

```bash
pnpm install
```

Lần chạy đầu, Electron tự tải file chạy của nó (~100 MB).

## Lệnh thường dùng

| Lệnh             | Việc                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`       | Mở app desktop ở chế độ dev (sửa giao diện là thấy ngay)                      |
| `pnpm lint`      | ESLint + kiểm định dạng Prettier                                              |
| `pnpm format`    | Tự định dạng lại mã                                                           |
| `pnpm typecheck` | Kiểm kiểu TypeScript cho mọi gói                                              |
| `pnpm test`      | Chạy test (Vitest)                                                            |
| `pnpm test:live` | Test hợp đồng với CLI thật — cần `NSA_LIVE_CONTRACT=1` (tốn token)            |
| `pnpm build`     | Build mọi gói thư viện và app desktop                                         |
| `pnpm dist:win`  | Tạo bộ cài Windows ở `apps/desktop/release/<version>/NSA-Setup-<version>.exe` |

Logo gốc ở [`apps/desktop/build/icon.svg`](apps/desktop/build/icon.svg). Sửa xong thì xuất lại các file PNG:

```bash
pnpm --filter @nsa/desktop icons
```

## Cấu trúc

```
apps/desktop          Electron + React (main / preload / renderer)
packages/core         lõi NSA: hợp đồng IPC, ChatService, định tuyến, ổ cắm, phát hiện thay đổi CLI
packages/adapter-sdk  hợp đồng adapter, trình chạy CLI, cổng chặn lệnh, bộ test hợp đồng
packages/adapters/*   claude, codex, opencode, gemini, antigravity, pty, api (gọi thẳng bằng API key); contract-live (test với CLI thật)
packages/providers    file dữ liệu hãng/model, kho khoá, chọn model theo việc, chi phí, cấp key cho CLI
packages/mcp-gateway  cổng MCP (khung)
packages/memory       NSA Mem: kho Markdown + git, chỉ mục FTS5, hộp duyệt, chắt lọc, nhập lịch sử, MCP tạm
packages/plugin-sdk   SDK plugin (khung)
plugins/*             app của App Store (giai đoạn 3+)
docs/                 kế hoạch, ADR
```

## Phát hành

1. Tăng `version` trong `apps/desktop/package.json`, commit, merge vào `main`.
2. Gắn tag trùng version, ví dụ `v0.1.0`, và push tag.
3. Workflow **Release Windows** build bộ cài và tạo GitHub Release dạng **nháp**.
4. Kiểm tra rồi bấm **Publish** trên GitHub. Từ lúc đó, app đã cài sẽ tự tải bản mới (kiểm khi mở app và mỗi 4 giờ). Thanh bên hiện **Khởi động lại** để cài ngay; nếu không bấm thì app tự cài khi thoát.

Thử tự cập nhật mà không phát hành lên GitHub:

1. Build bản cũ, cài thử.
2. Tăng version, build lại. Đặt `latest.yml`, bộ cài mới và file `.blockmap` của cả hai bản vào một thư mục, rồi phục vụ thư mục đó qua HTTP.
3. Mở bản cũ với biến môi trường `NSA_UPDATE_URL` trỏ tới thư mục đó (ví dụ `http://127.0.0.1:8765/`). Muốn thử đúng như khi mở từ Start Menu (không có biến môi trường) thì sửa `resources\app-update.yml` của bản đã cài thành `provider: generic` + `url: http://127.0.0.1:8765/`.

Sau khi bấm **Khởi động lại**, bộ cài cài im lặng rồi mở lại `NSA.exe` (xem `apps/desktop/build/installer.nsh` — mặc định electron-builder mở qua lối tắt Start Menu và Windows báo không tìm thấy lối tắt).

Chạy thử mà không đụng dữ liệu thật: mở app với `NSA_USER_DATA=<thư mục>` — cuộc trò chuyện, bộ nhớ, nhật ký nằm trong thư mục đó.

Thử đường lùi tầng / đổi agent mà không phá CLI thật: mở app với `NSA_SIMULATE_BROKEN=claude` (tầng JSON của Claude hỏng → lùi xuống tầng văn bản thô) hoặc `NSA_SIMULATE_BROKEN=claude:missing` (như chưa cài → đổi agent).

Ký mã: đặt secret `WIN_CSC_LINK` (file `.pfx` mã hoá base64 hoặc URL) và `WIN_CSC_KEY_PASSWORD` trong repo. Chưa đặt thì bộ cài vẫn tạo được nhưng không ký (Windows sẽ cảnh báo khi cài). Chi tiết: [ADR-0003](docs/adr/0003-dong-goi-va-tu-cap-nhat.md).

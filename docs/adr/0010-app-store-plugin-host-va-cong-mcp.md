# ADR-0010: App Store — plugin host, cô lập tiến trình, cổng MCP chung, gói có chữ ký

- Trạng thái: Chấp nhận
- Ngày: 2026-11-13
- Bổ sung cho [ADR-0005](0005-o-cam-chinh-sach-nhat-ky-danh-tinh.md) (ổ cắm), [ADR-0007](0007-chan-tung-lenh-qua-cong-chinh-sach.md) và [ADR-0008](0008-nsa-mem.md) (server MCP tạm của bộ nhớ nay nằm trong cổng này)

## Bối cảnh

Giai đoạn 3 của [PLAN.md](../PLAN.md): mỗi app là một plugin, tool viết một lần theo chuẩn MCP, mọi lời gọi tool đi qua ổ cắm chính sách, cài / gỡ không cần khởi động lại.

## Quyết định

### Các gói

- `@nsa/plugin-sdk` — thuần kiểu + bộ kiểm tra (không dùng Node): manifest `nsa-plugin.json`, so sánh phiên bản, kiểu API cho người viết plugin. Giao diện và plugin đều import được.
- `@nsa/plugin-host` — mã Node của lõi: gói `.nsapkg` + chữ ký, `PluginHost`, tiến trình plugin, kho (file chỉ mục), cầu nối tới NSA Mem, công cụ `nsa-plugin` (validate / keygen / pack).
- `@nsa/mcp-gateway` — một server MCP duy nhất.

### Manifest

`id`, `name`, `icon` (`emoji:🙂` hoặc svg/png trong gói), `version`, `nsa` (dải phiên bản NSA tương thích), `main`, `permissions`, `tools`, `screens`, `jobs`, `memory`. Bộ kiểm tra trả MỌI lỗi cùng lúc, kèm vị trí (`tools[1].name`) và lời giải thích tiếng Việt.

Quyền xin cấp: `network` (danh sách tên miền, `*.a.com` được), `folders` (id + nhãn + `read`/`readwrite`; người dùng chọn thư mục thật lúc cấp), `memory` (nhánh nhớ riêng), `notifications`. Không xin thì không bao giờ có. Người dùng bỏ chọn từng quyền khi cài và thu hồi / cấp lại ở màn hình Quản lý (plugin khởi động lại với quyền mới).

### Cổng MCP (`McpGateway`)

- Một server HTTP `127.0.0.1`, cổng ngẫu nhiên, mã bí mật 24 byte theo từng lượt chạy (như ADR-0008), tên server `nsa` (Claude thấy `mcp__nsa__<tool>`). Gắn cho agent bằng `attachMcp` đã có.
- Danh sách tool tính lại mỗi lần agent liệt kê: bật / tắt / gỡ plugin có hiệu lực ở lượt kế tiếp.
- Tool plugin tên `<plugin>__<tool>` (`ghi_chu_nhanh__add_note`).
- **Mọi lời gọi** → `Policy.check({ kind: 'mcp.tool', source, pluginId, tool, sensitive, input })` → cho phép / hỏi / chặn → `AuditLog` (`mcp_tool`). Chính sách ném lỗi = chặn. Tool đánh dấu `sensitive` trong manifest: bản Cá nhân **luôn hỏi mỗi lần** qua `ChatService.askUser` (cùng hộp Cho phép / Từ chối với ADR-0007); không trả lời / từ chối thì không chạy.
- Ba tool `mem_search` / `mem_read` / `mem_propose` chuyển vào cổng (nguồn `memoryToolSource`), hành vi giữ nguyên, `mem_propose` vẫn chỉ vào hộp duyệt. `McpHttpServer` của gói bộ nhớ đã bỏ. Tên server đổi `nsa_mem` → `nsa`.
- Việc cài / cập nhật / bật plugin cũng qua `Policy` (`plugin.manage`); vòng đời plugin vào `AuditLog` (`plugin`).
- Adapter `api` (không có MCP) **chưa nối** vào cổng: nó có interface nhận danh sách tool nhưng chưa có vòng lặp gọi tool — để sau.

### Cô lập plugin — chặn được gì, không chặn được gì (Windows)

Mỗi plugin chạy trong một tiến trình riêng: `node --permission …` (trong app: `NSA.exe` với `ELECTRON_RUN_AS_NODE=1`, đã thử cả bản đóng gói).

**Chặn được (có test tự động chạy với `node --permission`; chưa thử riêng trong app thật):**

- **File**: mô hình quyền của Node. Plugin chỉ đọc thư mục cài của nó, đọc / ghi thư mục dữ liệu của nó và các thư mục người dùng đã cấp. Không đọc được kho khoá, `state.json`, cấu hình app, dữ liệu plugin khác; không ghi được vào chính mã nguồn của mình. Quyền chỉ đọc thì không ghi được.
- **Sinh tiến trình con, worker, addon native**: bị cấm.
- **Biến môi trường**: tiến trình con không thừa kế gì của app (không khoá, không token); chỉ có `SystemRoot`/`windir`.
- **Key API**: nằm trong kho khoá của app (main), không đi vào tiến trình plugin, không có API nào để hỏi.
- **Treo / sập**: mỗi lời gọi có hạn (30 giây; việc nền 5 phút); quá hạn thì giết và khởi động lại; thoát bất thường thì khởi động lại có giãn cách, sập > 3 lần / phút thì dừng hẳn và báo; ping định kỳ phát hiện vòng lặp vô hạn. App không bị ảnh hưởng.
- **Cấu hình trần bộ nhớ** heap 256 MB.

**Chặn bằng mã, không phải bằng hệ điều hành (yếu hơn):**

- **Mạng**: Node 24 chưa có quyền mạng. `runner` (chạy trước mã plugin) thay `fetch` bằng hàm đi qua tiến trình chủ — chủ kiểm tên miền theo quyền đã cấp (kiểm lại ở từng bước chuyển hướng, từ chối địa chỉ IP) — và làm `net`, `tls`, `http(s)`, `http2`, `dgram`, `dns`, `WebSocket`, `process.binding` ném lỗi. Plugin viết ngay thẳng không lách được; **mã độc có lỗ hổng của Node / V8 để khai thác thì có thể thoát khỏi lớp này**.

**Không chặn được (giới hạn trung thực):**

- Không có AppContainer / Job Object / tường lửa theo tiến trình trên Windows: tiến trình plugin chạy cùng tài khoản người dùng, nên nếu lớp trên bị vượt thì không còn tầng chặn thứ hai. Không giới hạn CPU, số tiến trình, hay băng thông.
- Quyền `read` thư mục cho đọc đệ quy cả thư mục đó.
- Plugin có `network` tới một tên miền thì có thể gửi dữ liệu nó đọc được (thư mục đã cấp, nhánh nhớ) tới tên miền đó — đó là điều quyền này nghĩa là.
- Tin vào tên miền, không vào địa chỉ IP: tên miền được cấp mà trỏ vào `127.0.0.1` thì plugin tới được dịch vụ trên máy.
- Màn hình plugin: `<iframe sandbox="allow-scripts">` không có `allow-same-origin`, nội dung từ `nsa-plugin://<id>/` với CSP chặt (không mạng, không form, không khung lồng), nói chuyện với plugin chỉ qua `window.nsa.call/on`. Không chạm được API Electron hay renderer chính. Giới hạn: màn hình chạy script của plugin trong tiến trình giao diện của Chromium — dựa vào cô lập của Chromium.
- Hướng làm mạnh hơn (chưa làm): chạy plugin trong AppContainer / Job Object qua một trình chạy native nhỏ, hoặc Windows Filtering Platform; đặt vào giai đoạn 9 (hộp cát) hoặc trước khi mở kho công khai (giai đoạn 8).

### Gói, chữ ký, kho

- `.nsapkg` = JSON nén gzip `{ files: { đường/dẫn: base64 }, signature? }`. Không dùng zip để khỏi thêm phụ thuộc và khỏi lỗi "zip slip": mọi đường dẫn bị kiểm (không `..`, không tuyệt đối, không ổ đĩa).
- Chữ ký **Ed25519** (`node:crypto`) trên bản mô tả chuẩn hoá `{ tên nhà phát hành, SHA-256 từng file }`. Sửa / thêm / xoá một byte hoặc đổi tên nhà phát hành sau khi ký → `tampered` → **luôn bị từ chối** (không chính sách nào gỡ được).
- Mức tin cậy: `trusted` (chữ ký đúng + khoá trong `plugins/trusted-publishers.json`), `untrusted` (đúng nhưng khoá lạ), `unsigned` (không ký / cài từ thư mục). Khoá của nhà phát hành chính thức và quy trình cấp khoá là giai đoạn 8; hiện danh sách tin cậy do người dùng / IT thêm tay.
- Chính sách Cá nhân: `trusted` → cài; `untrusted` / `unsigned` → chỉ khi bật **chế độ nhà phát triển**, và vẫn hỏi xác nhận kèm cảnh báo; chưa bật chế độ này thì bị từ chối.
- Kiểm tương thích: trường `nsa` so với phiên bản app; không hợp thì từ chối kèm lời giải thích.
- Kho: `PluginRegistry` đọc một file chỉ mục (đường dẫn hoặc URL) sau interface `PluginSource`, tuỳ chọn mã băm SHA-256 từng gói. Có cờ `compatible` / `updateAvailable`. Kho trực tuyến thật + thanh toán là giai đoạn 8; kho riêng và danh sách cho phép là giai đoạn 9 (chỉ cần cắm `PluginSource` + `Policy`).

### Bộ nhớ của plugin

Nhánh `plugin/<id>/<nhánh>` trong NSA Mem, ẩn mặc định, tạo khi người dùng cấp quyền `memory`. Plugin chỉ tìm / đọc / đề xuất trong nhánh của mình (cầu nối lọc theo tiền tố). Đề xuất đi qua hộp duyệt và quy tắc tự duyệt như mọi nguồn, nguồn gốc `plugin:<id>`, vẫn qua `memory.propose` của `Policy`. Gỡ plugin giữ lại các mục nhớ (người dùng xoá ở màn hình Bộ nhớ). Lưu ý: `mem_search` của agent thấy cả nhánh này.

## Kết quả chạy thật (2026-11-13)

Dev (`pnpm dev`) và bản đóng gói (`NSA.exe`, thư mục dữ liệu riêng), plugin mẫu `ghi-chu-nhanh`:

- Cài từ kho (file chỉ mục) → gói ký tin cậy → hộp xin quyền → có trong lưới → mở màn hình, thêm ghi chú, việc nền cập nhật qua `nsa.on` → **không khởi động lại app**.
- **Claude Code** thật gọi `add_note` / `list_notes` qua cổng; `clear_notes` (nhạy cảm) hiện hộp hỏi, từ chối thì không chạy. **OpenCode** thật gọi `list_notes` và nhớ điều Claude đã dạy qua `mem_propose` ("mèo tên Mít Tố Nữ").
- Tắt plugin: Claude ở lượt kế tiếp không còn thấy tool. Gỡ: thư mục cài và thư mục dữ liệu biến mất. Trạng thái giữ qua lần mở lại.
- Bản đóng gói: cài + gọi `add_note` bằng Claude Code thật chạy được.
- **Chưa chạy thật**: Codex qua cổng (cùng cơ chế `attachMcp` đã chạy ở giai đoạn 2); kiểm cô lập (đọc ngoài quyền, mạng) chỉ có test tự động, chưa thử trong bản đóng gói; chưa thử nhiều plugin chạy song song lâu dài.

## Hệ quả

- Plugin giai đoạn 4–7 chỉ cần manifest + `main` + màn hình; nhận quyền, chính sách, nhật ký từ lõi.
- Plugin phải đóng gói thành một file (không có `node_modules` đi kèm) — bundle bằng công cụ tuỳ ý trước khi pack.
- Đổi tên server MCP `nsa_mem` → `nsa` nên lời nhắc trong NSA Mem và test hợp đồng đã sửa theo.

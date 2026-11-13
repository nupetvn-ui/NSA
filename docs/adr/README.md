# Ghi chép quyết định kiến trúc (ADR)

Mỗi quyết định kỹ thuật đáng kể được ghi thành một file đánh số. Không sửa ADR đã chấp nhận; quyết định thay đổi thì viết ADR mới và ghi "Thay thế ADR-xxxx".

| Số                                                               | Tiêu đề                                                                             | Trạng thái |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| [0001](0001-monorepo-pnpm-typescript.md)                         | Monorepo pnpm + TypeScript strict                                                   | Chấp nhận  |
| [0002](0002-electron-vite-va-ipc.md)                             | Electron + electron-vite, IPC có kiểu                                               | Chấp nhận  |
| [0003](0003-dong-goi-va-tu-cap-nhat.md)                          | Đóng gói NSIS, tự cập nhật qua GitHub, ký mã                                        | Chấp nhận  |
| [0004](0004-adapter-cli-va-chuyen-giao.md)                       | Adapter CLI headless JSON, chuyển giao ngữ cảnh                                     | Chấp nhận  |
| [0005](0005-o-cam-chinh-sach-nhat-ky-danh-tinh.md)               | Ổ cắm chính sách, nhật ký, danh tính                                                | Chấp nhận  |
| [0006](0006-dieu-phoi-nhieu-agent-va-ba-tang.md)                 | Điều phối nhiều agent, ba tầng tự lùi, phát hiện thay đổi                           | Chấp nhận  |
| [0007](0007-chan-tung-lenh-qua-cong-chinh-sach.md)               | Chặn từng lệnh qua cổng chính sách                                                  | Chấp nhận  |
| [0008](0008-nsa-mem.md)                                          | NSA Mem: Markdown + git, FTS5, hộp duyệt, MCP tạm                                   | Chấp nhận  |
| [0009](0009-nguon-model-qua-api-key.md)                          | Nguồn model qua API key, kho khoá, chọn model theo việc                             | Chấp nhận  |
| [0010](0010-app-store-plugin-host-va-cong-mcp.md)                | App Store: plugin host, cô lập, cổng MCP chung, gói ký                              | Chấp nhận  |
| [0011](0011-kenh-chat-plugin-khe-bi-mat-va-canh-nhom-theo-lo.md) | Kênh chat: token không tới plugin, cổng hành động, canh nhóm theo lô, Zalo          | Chấp nhận  |
| [0012](0012-quyen-cli-va-plugin-google-workspace.md)             | Quyền cli: lõi chạy chương trình dòng lệnh hộ plugin; plugin Google Workspace (gws) | Chấp nhận  |
| [0013](0013-plugin-kiotviet.md)                                  | Plugin KiotViet: Public API bán lẻ / bán buôn cho agent                             | Chấp nhận  |

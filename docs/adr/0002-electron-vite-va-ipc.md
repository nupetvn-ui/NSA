# ADR-0002: Electron + electron-vite, IPC có kiểu

- Trạng thái: Chấp nhận
- Ngày: 2026-11-11

## Bối cảnh

NSA cần chạy CLI, file hệ thống và tiến trình nền (việc của Node) đồng thời có giao diện hiện đại. Giao diện sẽ hiển thị nội dung không tin cậy (đầu ra của agent, tin nhắn từ kênh chat), nên renderer phải bị cô lập.

## Quyết định

- **Electron 45** + **React 19**, build bằng **electron-vite 6** (Vite 8): một cấu hình cho ba phần main / preload / renderer, có HMR khi dev.
- Bảo mật cửa sổ: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP chặt trong `index.html`, chặn mở cửa sổ mới (link `https` mở bằng trình duyệt ngoài).
- **Hợp đồng IPC nằm ở `@nsa/core`** (`IpcContract`): mỗi kênh khai báo kiểu tham số và kết quả. Main đăng ký trình xử lý theo kiểu `Handlers` (thiếu kênh là lỗi biên dịch); preload chỉ lộ `window.nsa.invoke(channel, ...args)` và từ chối kênh không có trong `IPC_CHANNELS`.
- Lõi NSA (`NsaCore`) hiện chạy **trong tiến trình main**. Khi orchestrator/adapter nặng lên (giai đoạn 1), có thể tách sang `utilityProcess` mà không đổi hợp đồng IPC phía renderer.
- Gói `@nsa/*` được gộp từ mã nguồn vào bundle main/preload qua `resolve.alias` trong `electron.vite.config.ts` (khai báo từng gói), nên dev không cần build gói trước.

## Hệ quả

- Thêm lệnh mới: khai báo trong `IpcContract` + `IPC_CHANNELS`, viết handler trong `apps/desktop/src/main/ipc.ts`; TypeScript bắt sai kiểu ở cả ba phía.
- Gói `@nsa/*` mới dùng trong main phải thêm vào `workspaceAlias`.

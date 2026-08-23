/* global chrome */
const code = document.querySelector("#code");
const status = document.querySelector("#status");
const button = document.querySelector("#pair");

button.addEventListener("click", async () => {
  const pairingCode = code.value.trim().toUpperCase();
  if (pairingCode.length !== 8) { status.textContent = "กรุณากรอกรหัสให้ครบ 8 ตัว"; return; }
  button.disabled = true;
  status.textContent = "กำลังเชื่อมต่อ...";
  try {
    const response = await fetch("http://127.0.0.1:4317/v1/extension/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    const data = await response.json();
    if (!response.ok || !data.token) throw new Error(data.error || "จับคู่ไม่สำเร็จ");
    await chrome.storage.local.set({ alphaToolToken: data.token });
    status.textContent = "เชื่อมต่อแล้ว คุณปิดหน้านี้ได้";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ";
  } finally {
    button.disabled = false;
  }
});

import { writeFile } from "node:fs/promises";
const url = "https://tessdata.projectnaptha.com/4.0.0/chi_sim.traineddata.gz";
const SIZE = 20159757;
const CHUNK = 3 * 1024 * 1024;
const parts = [];
for (let start = 0; start < SIZE; start += CHUNK) {
  const end = Math.min(start + CHUNK - 1, SIZE - 1);
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { Range: "bytes=" + start + "-" + end } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === end - start + 1) {
        parts.push(buf);
        ok = true;
        console.log("ok " + (start + buf.length) + "/" + SIZE);
      } else {
        console.log("short " + buf.length);
      }
    } catch (e) {
      console.log("err " + e.message);
    }
  }
  if (!ok) { process.exit(1); }
}
const all = Buffer.concat(parts);
await writeFile("public/tesseract/chi_sim.traineddata.gz", all);
console.log("done " + (all.length / 1024 / 1024).toFixed(1) + "MB");

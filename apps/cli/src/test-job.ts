import path from "node:path";
import { JobStore } from "@youcreator/core";

const store = new JobStore(
  path.resolve("storage/jobs"),
);

const job = await store.create({
  title: "Why Humans Procrastinate",
  mode: "B",
  durationSeconds: 60,
  resolution: "1920x1080",
  fps: 30,
});

console.log("Created job:", job);

const loaded = await store.get(job.id);
console.log("Loaded job:", loaded);

const updated = await store.update(job.id, {
  status: "running",
});

console.log("Updated job:", updated);
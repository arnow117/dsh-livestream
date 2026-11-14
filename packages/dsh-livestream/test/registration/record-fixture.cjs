const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const root = process.env.TASK_FIXTURE_ROOT;
  fs.appendFileSync(path.join(root, "actions.log"), request.action + "\n");
  if (request.action === "user_info") {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        identity: "user",
        data: { open_id: "user1" },
      }),
    );
    return;
  }
  if (request.action !== "record_get") {
    process.exitCode = 2;
    return;
  }
  const binding = JSON.parse(
    fs.readFileSync("registration-binding.json", "utf8"),
  );
  const fixture = JSON.parse(
    fs.readFileSync(path.join(root, "row.json"), "utf8"),
  );
  const respond = () => {
    if (fixture.malformed) {
      process.stdout.write("{broken");
      return;
    }
    const ids = binding.fields;
    const types = ids.map((id) =>
      id === "f3" ? "attachment" : id === "rev" ? "number" : "text",
    );
    process.stdout.write(
      JSON.stringify({
        ok: true,
        identity: "user",
        data: {
          timezone: "UTC",
          ...(fixture.ignoredFields ? { ignored_fields: ["f2"] } : {}),
          fields: ids.map(() => "field"),
          field_id_list: ids,
          field_type_list: types,
          record_id_list: [fixture.wrongRecord ? "different" : "record1"],
          data: [ids.map((id) => fixture.fields[id] ?? null)],
        },
      }),
    );
  };
  if (fixture.delay) {
    fs.writeFileSync(path.join(root, "read-entered"), "entered");
    setTimeout(respond, 2000);
  } else respond();
});

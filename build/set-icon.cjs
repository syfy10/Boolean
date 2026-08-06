// Sets the icon + version info on the standalone core exe (run before SEA injection).
// Usage: node build/set-icon.cjs <exe> <ico>
const { rcedit } = require("rcedit");

rcedit(process.argv[2], {
  icon: process.argv[3],
  "version-string": {
    ProductName: "Boollm",
    FileDescription: "Boollm - local AI workspace",
    CompanyName: "Boollm",
    LegalCopyright: "Copyright 2026 Boollm",
    OriginalFilename: "Boollm-core.exe"
  },
  "file-version": "0.9.71",
  "product-version": "0.9.71"
})
  .then(() => console.log("icon + version info set"))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

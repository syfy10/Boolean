// Sets the icon + version info on the standalone core exe (run before SEA injection).
// Usage: node build/set-icon.cjs <exe> <ico>
const { rcedit } = require("rcedit");

rcedit(process.argv[2], {
  icon: process.argv[3],
  "version-string": {
    ProductName: "Boolean",
    FileDescription: "Boolean - local AI workspace",
    CompanyName: "Boolean",
    LegalCopyright: "Copyright 2026 Boolean",
    OriginalFilename: "Boolean-core.exe"
  },
  "file-version": "0.9.25",
  "product-version": "0.9.25"
})
  .then(() => console.log("icon + version info set"))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

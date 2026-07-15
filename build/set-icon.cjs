// Sets the icon + version info on dist/saz.exe (run before SEA injection).
// Usage: node build/set-icon.cjs <exe> <ico>
const { rcedit } = require("rcedit");

rcedit(process.argv[2], {
  icon: process.argv[3],
  "version-string": {
    ProductName: "Boolean",
    FileDescription: "Boolean - local AI workspace",
    CompanyName: "Boolean",
    LegalCopyright: "Copyright 2026 Boolean",
    OriginalFilename: "saz.exe"
  },
  "file-version": "0.9.6",
  "product-version": "0.9.6"
})
  .then(() => console.log("icon + version info set"))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

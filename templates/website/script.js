document.getElementById("year").textContent = new Date().getFullYear();
let count = 0;
document.getElementById("btn").addEventListener("click", () => {
  count++;
  document.getElementById("count").textContent = count;
});

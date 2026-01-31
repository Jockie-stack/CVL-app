import bcrypt from "bcryptjs";

const pwd = process.argv[2] || process.env.ADMIN_PASSWORD;
if (!pwd) {
  console.error("Usage: node tools/make-admin-hash.js <motdepasse>  (ou env ADMIN_PASSWORD)");
  process.exit(1);
}

const hash = await bcrypt.hash(pwd, 12);
console.log(hash);

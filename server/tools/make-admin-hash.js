import bcrypt from 'bcrypt';
const password = 'CVL-2025!Secure#Admin42'; // Votre mot de passe
bcrypt.hash(password, 10, function(err, hash) {
  if (err) throw err;
  console.log(hash); // Le hachage de votre mot de passe
});

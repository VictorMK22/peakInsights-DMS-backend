const bcrypt = require("bcryptjs")

bcrypt.compare(
  "Square@32",
  "$2a$12$dpTs0vnUmUB4cQRsJAQlleylx6ouNOnDBYM4YwxHrOa2m8eNEPVn2"
).then(console.log)
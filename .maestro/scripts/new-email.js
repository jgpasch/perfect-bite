// A fresh address for each run, so every test signs up a new user and needs no database reset.
// Saved as output[NAME], so a flow with several users can keep each one's address. Lower case, as the
// server stores invited emails, so a flow can match it on screen.
output[NAME] = ('e2e-' + NAME + '-' + Date.now() + '@example.com').toLowerCase();

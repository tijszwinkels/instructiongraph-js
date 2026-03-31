# Tutorial: Getting Started with InstructionGraph

This walkthrough takes you from zero to creating and reading objects, both offline and online.

## 1. Install

```bash
npm install -g @instructiongraph/ig
```

Or, to hack on the source:

```bash
git clone https://github.com/tijszwinkels/instructiongraph-js.git
cd instructiongraph-js
npm link
```

## 2. Create an identity

Every object you create is signed with your identity — an ECDSA P-256 keypair. Generate one:

```bash
ig identity generate
```

```
Initialized InstructionGraph at /home/you/.instructionGraph
  Created: /home/you/.instructionGraph/data/
  Created: /home/you/.instructionGraph/config/
  Created: /home/you/.instructionGraph/identities/
Generated identity: default
Pubkey: AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ
PEM saved: /home/you/.instructionGraph/identities/default/private.pem
Set as active identity

You are currently offline — objects stay on local filesystem only.
To sync with a hub server:
  ig server set https://dataverse001.net
```

This creates `~/.instructionGraph/` with your keypair and an empty data store. You're now ready to create objects — no server needed.

Check your identity anytime:

```bash
ig identity
```

## 3. Create your first object (offline)

Let's create a social-network–style post. Write a spec file — a simple JSON describing what you want:

```bash
cat > my-first-post.json << 'EOF'
{
  "type": "POST",
  "content": {
    "title": "Hello from the InstructionGraph!",
    "body": "This is my first post. It's signed, self-describing, and lives on my filesystem."
  }
}
EOF
```

Now sign and store it:

```bash
ig create my-first-post.json
```

```
○ offline (ig server set <url> to connect)
AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.f47ac10b-58cc-4372-a567-0e02b2c3d479
```

That output is the object's **ref** — its globally unique identifier. The `○ offline` indicator tells you this object is stored locally only.

The object is now a signed JSON file in `~/.instructionGraph/data/`. You can inspect it:

```bash
ig get AxyU5_...f47ac10b-...
```

Notice a few things the library did automatically:
- **Signed** the object with your private key
- **Set the realm** to your identity's pubkey (private by default!)
- **Added an author relation** pointing to your identity
- **Generated a UUID** and composed the ref

## 4. Understanding realms: private vs public

By default, new objects go into your **identity realm** — your pubkey used as a realm name. This means only you can read them (after authenticating with a hub server). It's a safe default.

Check your current realm:

```bash
ig realm
```

```
Current realm: AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ (identity realm — private)
New objects will only be visible to you.
```

To make objects public, switch to the `dataverse001` realm:

```bash
ig realm set dataverse001
```

```
Set default realm: dataverse001 (public)
New objects will be visible to everyone.
```

Now anything you create will have `"in": ["dataverse001"]` — visible to anyone. You can switch back anytime:

```bash
ig realm set identity    # Back to private
```

You can also set the realm per-object by putting `"in"` directly in the spec:

```bash
cat > public-post.json << 'EOF'
{
  "type": "POST",
  "in": ["dataverse001"],
  "content": {
    "title": "A public post",
    "body": "This one is visible to everyone, regardless of my default realm."
  }
}
EOF

ig create public-post.json
```

## 5. Connecting to a hub server (going online)

So far everything is on your filesystem. To share objects with the world (or back them up), connect to a hub:

```bash
ig server set https://dataverse001.net
```

```
Connected to https://dataverse001.net
Objects will now sync between local filesystem and the hub.
```

From now on, every `ig create` signs locally *and* pushes to the hub. Every `ig get` checks the hub for newer versions. Your local copy is always kept — if the server goes down, you keep working.

Push any objects you already created offline:

```bash
ig server push
```

```
Pushing local objects to https://dataverse001.net...
[1/2] ✓ AxyU5_...f47ac10b-...
[2/2] ✓ AxyU5_...a2b3c4d5-...

Done. 2 pushed, 0 errors, 2 total.
```

## 6. Authenticate (for private objects on the hub)

Public objects (realm: `dataverse001`) are readable by anyone. But if you have private objects (identity realm), the hub needs to know who you are:

```bash
ig auth
```

```
● https://dataverse001.net
Authenticated as AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ
Token: <base64url token>
```

This uses ECDSA challenge-response — the hub sends a random challenge, you sign it with your private key, and get a session token. No passwords leave your machine.

## 7. Search and discover

Find objects on the hub:

```bash
# Search for all POSTs
ig search --type POST --limit 5

# Search by a specific author
ig search --by AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ --type POST

# Find objects that link to a specific ref (inbound relations)
ig inbound AxyU5_...00000000-... --relation author
```

## 8. Create a reply (using relations)

Objects link to each other through **relations**. Let's reply to a post:

```bash
cat > reply.json << 'EOF'
{
  "type": "POST",
  "in": ["dataverse001"],
  "content": {
    "title": "Great post!",
    "body": "Welcome to the dataverse."
  },
  "relations": {
    "replies_to": [{ "ref": "AxyU5_...f47ac10b-..." }]
  }
}
EOF

ig create reply.json
```

Now anyone can find your reply by querying inbound relations on the original post:

```bash
ig inbound AxyU5_...f47ac10b-... --relation replies_to
```

## 9. Verify a signed object

Got an InstructionGraph JSON file from somewhere? Verify its signature:

```bash
ig verify some-object.json
```

```
Verified OK
```

This checks the ECDSA signature against the pubkey embedded in the object — no network needed.

## 10. Going back offline

Don't need the server anymore? Disconnect:

```bash
ig server remove
```

```
Server removed. Now in offline mode.
Your local objects are still on disk — nothing was deleted.
```

Everything you synced is still on your filesystem.

---

**Next:** See the [README](./README.md) for the library API, store interface, and full CLI reference.

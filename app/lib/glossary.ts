// "What's this?" explanations for the words a new player has never seen.
// Written for kids and teens: short sentences, "you", no networking jargon
// where it can be avoided. One map so the same word says the same thing on
// every screen. Rendered by app/components/Term.tsx.

export interface GlossaryEntry {
  title: string;
  body: string;
}

export const GLOSSARY = {
  Vanilla: {
    title: "Vanilla",
    body: "The normal Minecraft server, exactly as Mojang makes it. No mods and no plugins. Everyone can join with plain Minecraft.",
  },
  Paper: {
    title: "Paper",
    body: "A faster version of the Minecraft server. It runs plugins, which add things like home commands. Players still join with plain Minecraft.",
  },
  Purpur: {
    title: "Purpur",
    body: "Paper with extra settings you can change. It runs plugins too. Players still join with plain Minecraft.",
  },
  Fabric: {
    title: "Fabric",
    body: "A light way to run mods. Pick it when the mods you want say they need Fabric. Your friends need the same mods and Fabric to join.",
  },
  Quilt: {
    title: "Quilt",
    body: "A mod loader that works with most Fabric mods. Pick it only if a mod asks for Quilt.",
  },
  Forge: {
    title: "Forge",
    body: "The oldest and biggest way to run mods. Many big modpacks use it. Your friends need the same mods and Forge to join.",
  },
  NeoForge: {
    title: "NeoForge",
    body: "The newer version of Forge. Newer mods and modpacks use it. Your friends need the same mods and NeoForge to join.",
  },
  "mod loader": {
    title: "Mod loader",
    body: "A helper that lets Minecraft load mods. Fabric, Quilt, Forge and NeoForge are mod loaders. A mod only works with the loader it was made for.",
  },
  mod: {
    title: "Mod",
    body: "A file that changes the game itself, like new blocks, creatures or machines. Your friends usually need the same mods on their own computer to join.",
  },
  plugin: {
    title: "Plugin",
    body: "A file that adds features to the server, like home commands or protection. It only runs on the server, so your friends do not install anything.",
  },
  modpack: {
    title: "Modpack",
    body: "A ready-made bundle of mods that work well together. Pick one and MineUI sets the whole thing up for you.",
  },
  RCON: {
    title: "RCON",
    body: "A way to send commands to the server from outside the game. MineUI uses it for the Console and to read who is online.",
  },
  TPS: {
    title: "TPS",
    body: "How many times per second the server updates the game. 20 is perfect. If it drops lower, the game feels laggy.",
  },
  MSPT: {
    title: "MSPT",
    body: "How many milliseconds the server needs for one update. Lower is better. If it goes over 50, the server can not keep up.",
  },
  whitelist: {
    title: "Whitelist",
    body: "A list of the only people allowed in. If it is on, anyone not on the list can not join, even if they know where your server is.",
  },
  "op / admin": {
    title: "Op (admin)",
    body: "A player who can use powerful commands, like changing the weather or banning someone. Only give it to people you trust.",
  },
  EULA: {
    title: "EULA",
    body: "Mojang's rules for running a server. Minecraft will not start a server until you say you agree.",
  },
  container: {
    title: "Container",
    body: "A sealed box on your computer where the server runs on its own. It keeps the server away from your other files, and it is easy to move or reset.",
  },
  Podman: {
    title: "Podman",
    body: "A free program that runs containers. MineUI uses it to run your server in a box. You install it once.",
  },
  Docker: {
    title: "Docker",
    body: "A popular program that runs containers. MineUI can use it instead of Podman. You install it once.",
  },
  port: {
    title: "Port",
    body: "A numbered door into your computer. The Minecraft server listens at one door, usually 25565. Your friends knock on that door to join.",
  },
  Java: {
    title: "Java",
    body: "The program Minecraft servers run on. If your computer has no Java, the server can not start.",
  },
  "server.properties": {
    title: "server.properties",
    body: "The file with the server's main settings, like the game mode, difficulty and how many players fit. MineUI can edit it for you.",
  },
  backup: {
    title: "Backup",
    body: "A saved copy of your world. If something breaks or gets blown up, you can go back to the copy.",
  },
  world: {
    title: "World",
    body: "Everything you built and explored. It is saved in a folder on the server.",
  },
  server: {
    title: "Server",
    body: "A copy of Minecraft that stays running so your friends can join it. When the server is off, nobody can play on it.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryTerm = keyof typeof GLOSSARY;

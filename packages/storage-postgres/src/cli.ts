import { migrateSqliteToPostgres } from "./migrate.js";

const args = process.argv.slice(2);
const force = args.includes("--force");
const [sqlitePath, connectionString] = args.filter(
  (arg) => arg !== "--force",
);
if (!sqlitePath || !connectionString) {
  console.error(
    "usage: npm run migrate:postgres -- <sqlite-path> <postgres-url> [--force]",
  );
  process.exit(2);
}
if (force) {
  console.warn(
    "--force: truncating conversations, entries, docs, submissions, jobs, tool_tasks, settings, and cancels",
  );
}

const counts = await migrateSqliteToPostgres(
  sqlitePath,
  connectionString,
  { reset: force },
);
console.log(
  `migrated ${counts.conversations} conversations, ${counts.entries} entries, ` +
    `${counts.submissions} submissions, ${counts.docs} docs, ` +
    `${counts.toolTasks} tool tasks, ${counts.settings} settings`,
);

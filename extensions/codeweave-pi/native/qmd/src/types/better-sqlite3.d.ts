declare module "better-sqlite3" {
  const Database: new (path: string) => unknown;
  export default Database;
}

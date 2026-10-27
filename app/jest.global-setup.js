/**
 * Tests own their git repositories. git exports GIT_DIR to a hook started from
 * a linked worktree (`.git/worktrees/<name>`), so `npm run ci` under the
 * pre-push hook ran the suite with it set, and every `git` a test spawned in
 * its temp repo acted on the developer's repository instead: commits on the
 * checked-out branch, stray branches and worktrees, core.bare and user.*
 * rewritten in its config.
 *
 * This runs in jest's parent process before any worker is forked, so workers
 * and the git they spawn inherit the cleaned environment. (setupFilesAfterEnv
 * is too late: each test file gets a copy of process.env, but a child process
 * spawned without an explicit env still inherits the worker's real one.)
 */
module.exports = function clearInheritedGitEnv() {
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
  ]) {
    delete process.env[key];
  }
};

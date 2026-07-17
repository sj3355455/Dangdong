# Deployment Workflow Rule

When making updates to the Dangdong score application, ALWAYS follow these three steps strictly:

1. **Update Version Display (버전 표시 올리기)**:
   - Update the version text (e.g. `v51` -> `v52`) in both `score/index.html` and `record/index.html` footers.
2. **Bump Service Worker Version (서비스 워커 캐시 버전 올리기)**:
   - Update the `CACHE` variable string in `sw.js` (e.g. `dangdong-score-v51` -> `dangdong-score-v52`) to ensure clients clear their stale cache.
3. **Commit and Push to GitHub (깃허브에 푸시)**:
   - Commit the changes and explicitly run `git push` so that the live site (GitHub Pages) gets the updates.

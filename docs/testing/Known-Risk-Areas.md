# Known Risk Areas

| Risk                              | What to verify                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Admin blank page after login      | BuhlOS shell paints visible content; legacy `/admin/operations` static guards stay green |
| Legacy UI returning               | Sidebar/nav shell remains; deprecated top-pill layout does not return                    |
| Route guard mismatch              | UI, middleware, and APIs agree on admin, LH, field, and client tiers                     |
| Draft jobs visible to field       | API and Phil list hide Draft and Archived rows                                           |
| Phil preview using mock data      | Builder preview states saved-data origin and renders saved tasks                         |
| Save state failing silently       | Dirty → saving → saved; refresh persists structure                                       |
| Serverless 503 / cold start       | Record transient failures; allow warning only when retry succeeds                        |
| Preview / production data leakage | Prefix data, avoid destructive mutation, park jobs as Draft                              |
| Plans coordinate drift            | Require `0..1` coordinate unit suite when overlays land                                  |
| Superseded plans shown as current | Phil renders current revisions only                                                      |
| Source PDF mutation               | Keep source PDF immutable; store overlays separately                                     |
| Phil becoming cluttered           | Keep field controls focused and read-only where intended                                 |

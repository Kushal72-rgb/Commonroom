# Commonroom — project submission document

> **Before submitting:** replace every `[TEAM TO COMPLETE]` field with accurate details. Keep all examples fictional unless your team has permission to use real data.

## Project summary

**Commonroom** is a campus resource-sharing application for a makerspace community. Members can find shared tools and spaces, request bookings and report issues. Resource owners manage listings, decide requests, handle handover and return, and review incident and activity records.

**Product link:** [TEAM TO COMPLETE — deploy and paste judge-accessible link]

**Source repository:** [TEAM TO COMPLETE — paste repository link and enable judge access]

**Organizer submission form:** [Open submission form](https://forms.gle/QTD1ZRuPX37Yef37A)

**Team / participant details:** [TEAM TO COMPLETE]

**Team roles and contributions:** [TEAM TO COMPLETE — name each member and their actual contribution]

## Selected use case and users

The application is designed for a campus makerspace community sharing equipment and rooms. Example catalogs and synthetic regression records are demonstration data; confirm the live catalog before presenting it as a real inventory.

- **Resource users:** students and project teams who need occasional access to tools or space.
- **Resource owners:** makerspace or lab staff who need to decide who can use their property, under what conditions, and when it was returned.

## Why this problem matters

Specialised equipment and rooms can sit idle while students and early-stage teams cannot afford to buy or privately rent them. Ordinary calendars make a slot visible, but do not by themselves establish training, owner approval, handover condition, return condition, incident handling or fair allocation. Commonroom treats these trust and operating steps as part of the booking itself.

## Proposed solution and complete workflow

1. An owner opens **List a resource**, supplies its name, category, location, description and usage rules, then publishes it.
2. A member searches or filters the resource catalog and opens a listing to read its access requirements.
3. The member selects a date, explains the intended use and acknowledges the requirements before sending a request.
4. The owner opens **Owner desk** and reviews the request and eligibility acknowledgement.
5. The owner approves, declines with a reason, or waitlists it. A waitlisted request can later be approved or declined. Each decision is added to the activity history.
6. An approved member opens **My requests**, checks in and records the resource's initial condition.
7. The member can report an issue and still return the resource with a separate final-condition note. Both actions are recorded separately.
8. The owner can inspect the booking notes, incident reports and activity history.

### Judge walkthrough

1. Open the product link and select **Owner desk** to see the resource manager view.
2. Return to **Discover**, select **Request access** on the Laser Cutter, choose a date, enter a project purpose, and submit.
3. Open **Owner desk** and approve the new request.
4. Open **My requests**, check in with a condition note, then return the tool with a final condition note.
5. Reopen **Owner desk** to see the completed booking record and activity history.
6. To demonstrate incident handling, create another booking and use **Report issue** after check-in. To demonstrate fair allocation, create a second request and place it on the waitlist.

## Features developed

- Resource listing with category, location, availability, usage conditions and owner.
- Search, category filters and an availability-today filter.
- Booking requests with date, purpose and eligibility acknowledgement.
- Owner approval, decline and waitlist actions.
- Check-in and return condition notes.
- Delay, damage or other issue reporting.
- Request cancellation while pending.
- Shared activity history for important workflow actions.
- Responsive layout for desktop and mobile browser widths.

## Technology and system architecture

- **Frontend:** vanilla HTML, CSS and JavaScript.
- **Frontend:** static HTML, CSS and vanilla JavaScript (`index.html`, `styles.css`, `app.js`, `api.js`, `workflow.js`).
- **Backend:** Node.js, Express and Mongoose under `backend/`; MongoDB stores users, resources, bookings, incidents and activity.
- **Authentication:** bcrypt password hashes and JWT bearer tokens; the browser retains the token in localStorage for refresh persistence.
- **External services:** the local development configuration uses the local MongoDB database. Google Fonts may load from its public font host; system font fallbacks are provided.

```text
index.html + styles.css
        │ renders views and collects actions
        ▼
app.js ── api.js — frontend workflows and HTTP requests
                    │ /api routes
                    ▼
          Express controllers + authorization
                    │ Mongoose
                    ▼
          Local MongoDB (commonroom)
```

The client and API enforce separate member and owner flows. Local development serves the static frontend separately from the API; use separate browser profiles to demonstrate cross-account workflows.

## Privacy, security, trust and fairness

- Demo people, resources and activity are fictional; the prototype does not request identity documents or confidential institutional records.
- Usage requirements and eligibility acknowledgement are visible to both member and owner. Owners make approval and safety decisions; no automated model decides access or penalties.
- The owner can approve, decline or waitlist a request; a waitlisted booking can be explicitly approved or declined. Booking actions and resource/incident events are represented in activity history.
- Server-side authorization protects owner actions and user-specific booking, incident and activity views. Synthetic accounts and records remain demonstration data, not institution-verified identities.
- The browser stores its JWT in localStorage, which is accessible to JavaScript running on the page. Use only in a trusted local development environment until a production security review and session-storage decision are complete.
- Fair allocation is demonstrated through owner-controlled waitlisting, later owner processing, and visible decision history. This version does not automatically enforce quotas or calculate queue priority.

## Testing instructions and judge access

- **Local frontend:** `http://127.0.0.1:8000/` (serve the project root as static files).
- **Local API health:** `http://127.0.0.1:5000/api/health`.
- **Accounts:** use the synthetic local demonstration accounts; do not put their passwords in a public submission. No public judge URL is configured here.
- **Frontend tests:** from the project folder, run `node --test tests/*.test.js`.
- **Backend tests:** from `backend/`, run `npm test` with local MongoDB and the private `backend/.env` configured.
- **Local startup:** in PowerShell, start the existing backend with `Set-Location D:\Hackathons\backend; npm start`, then serve the project root in a second terminal with `Set-Location D:\Hackathons; python -m http.server 8000 --bind 127.0.0.1`.
- **Recommended demonstration:** follow the Judge walkthrough above.

## Known limitations

- No institution SSO or institution-verified membership; role assignment is managed outside public member registration.
- Demo membership and owner labels do not verify an institution or person.
- No calendar integration, concurrent booking lock, email/SMS notification, photo upload, deposit/payment, formal dispute process or tamper-resistant audit storage.
- Waitlist placement is a manual owner decision; automated usage limits and priority rules are not implemented.
- This project has not been deployed as part of this local audit; do not treat the local URL as a judge-accessible product link.

## Future development

Add institution SSO and server-enforced roles; integrate training records and calendar availability; add fair-use quotas and explainable waitlist rules; support condition photos with consent and retention controls; provide reminders and owner notifications; and store append-only audit events with role-based access and incident-resolution status.

## Tools, templates and pre-existing materials disclosure

- Frameworks and libraries: no third-party JavaScript libraries; browser APIs only.
- Templates or starter code: [TEAM TO COMPLETE — disclose any used, or state none if accurate].
- AI tools: [TEAM TO COMPLETE — accurately disclose tools and how they were used].
- Development window: [TEAM TO COMPLETE — state when the submitted product was built and provide any requested evidence].

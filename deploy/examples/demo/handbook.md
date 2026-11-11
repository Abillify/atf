<!--
  SPDX-License-Identifier: Elastic-2.0
  SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

  Invented demo content for the ATF quickstart. Every company name, person,
  number, hour and policy below is made up for this example; none of it
  describes a real organisation. The file exists so the retrieval flow
  (`flows/03-grounded-retrieval.yaml`) has one document to find and cite, and it
  is loaded by the `seed` service in `compose.yaml`.
-->

# Northwind Cartography — Field Service Handbook

Edition 4, internal. This handbook tells a field technician what to do when
equipment on a customer site stops working. It is the only document the
quickstart indexes, so an answer from the retrieval flow should cite it.

## Who to call, and when

The support desk answers from 07:00 to 19:00 Central European Time, Monday to
Friday. Outside those hours a severity 1 incident — a site that cannot plot at
all — goes to the on-call cartographer by phone; the handover to the on-call
shift happens at 17:30 CET and the outgoing shift keeps the incident until the
on-call engineer has answered.

Severity 2 and severity 3 incidents are never escalated out of hours. They wait
for the desk to open. A technician who pages the on-call line for a severity 3
is asked to write down what happened in the ticket instead.

## Severity definitions

| Severity | Meaning | First response |
| --- | --- | --- |
| 1 | The site cannot produce any output and no workaround exists. | 30 minutes |
| 2 | Output is possible but degraded, or a workaround exists. | 4 hours |
| 3 | Cosmetic problem, or a question about normal use. | next business day |

First response means a person has read the report and replied, not that the
fault is fixed.

## Spare parts

Spare parts ship next business day from the warehouse in Huskvarna. Same-day
courier is reserved for severity 1 incidents and needs the approval of the duty
supervisor, who is reachable through the support desk — the supervisor's own
number is deliberately not published here.

A plotter head is a consumable and is never sent same-day, whatever the
severity. Ordered parts must be booked out of the technician's own stock within
two working days, otherwise the stock count is corrected automatically and the
technician receives a note about it.

## Printers and plotters that jam

Work from the back panel, never from the front, and switch the machine off
before reaching into the paper path. Pull jammed media slowly in the direction
of the paper path; tearing it leaves fragments that cause the next jam.

If a machine jams three times in the same hour, stop and open a severity 2
ticket with the machine serial number, the media lot number and a photo of the
torn media. Repeated jamming is almost always a media lot problem rather than a
faulty machine, and the photo is what gets the lot replaced.

Replacing a roller is a documented task with a published time of 20 minutes. It
does not need a supervisor. Replacing a fuser does need one, and it must be done
by someone trained on hot components.

## Remote access for contractors

Contractors get a VPN account for the duration of their assignment, never longer
than 90 days. The account belongs to the sponsoring employee, who has to confirm
the extension in person; a mail from the contractor is not enough. Contractor
accounts are disabled automatically on the 91st day and are not restored
automatically afterwards.

A contractor may read tickets they are named in. They may not read the customer
contract, the pricing sheet, or another contractor's tickets — this is checked on
every request, not only at login.

## Accounts and passwords

Password resets go through the self-service page, which needs a code from the
hardware token. If the token is lost, the sponsoring employee confirms the loss
in person and a temporary password is handed over in person as well. Nobody at
the support desk will accept a password by phone or mail, and a person claiming
to be from support will never ask for one.

Shared accounts are forbidden, including "the desk laptop". A shared account is
disabled on discovery and the sponsoring team has to file a replacement request.

## Working with customer data

Ticket notes may contain a machine serial number, a site name and a fault
description. They must not contain a customer's contract price, a person's
private address or a payment account number. If such a value ends up in a note,
delete it from the note and say in a follow-up note that you deleted it — the
audit trail keeps both notes, so nothing has to be hidden.

Before forwarding a ticket outside the support team, the ticket is checked for
personal data. The retrieval answer a technician reads is generated from this
handbook and from the tickets they are allowed to see, which is why two
technicians can get different answers to the same question.

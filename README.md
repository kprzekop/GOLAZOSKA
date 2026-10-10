# Rezerwacje premiery „Goła Zośka 1812”

Przygotowany system jest domyślnie zamknięty. Formularz pojawi się na stronie filmu dopiero po ustawieniu `RESERVATIONS_OPEN=true` i po podłączeniu bazy, poczty oraz Turnstile. Data pokazu: 21 listopada 2026. Godzina i sala są jeszcze do uzupełnienia w treści strony i e-maili przed uruchomieniem.

## Pojemność i zasady

- 81 miejsc fizycznych według organizatora. 60 miejsc w publicznej puli internetowej, 20 zaproszeń do obsługi ręcznej, 1 miejsce bez przydziału.
- Bez numerowanych miejsc. Miejsca stojące i wszelkie dodatkowe wejścia wymagają osobnej decyzji organizatora i zgody sali; system ich nie przydziela.
- W jednym zgłoszeniu można poprosić o 1–4 miejsca. Jeden aktywny zapis na adres e-mail.
- Zgłoszenie zajmuje miejsce na 24 godziny, do sprawdzenia adresu e-mail. Po kliknięciu ma status `reserved`. Od 14 listopada kliknięcie od razu potwierdza udział.
- 14 listopada rano wysyłana jest prośba o ponowne potwierdzenie. Termin: koniec 17 listopada czasu polskiego. Rezerwacje, którym wiadomość faktycznie wysłano, wygasają od 18 listopada; rezerwacje z błędem wysyłki nie wygasają automatycznie.
- Zwolnione miejsca trafiają w kolejności do listy rezerwowej. Każda propozycja blokuje miejsca na 48 godzin (najpóźniej do początku dnia premiery) i wymaga przyjęcia przez kliknięcie.
- 19 listopada wysyłane jest przypomnienie osobom potwierdzonym. Ręczne anulowanie i potwierdzenie przez organizatora są dostępne w `/organizator.html`; CSV służy do przygotowania listy na wejście.
- Liczby miejsc nie są publikowane w widoku dla widzów.

## Uruchomienie

1. W projekcie Vercel dołącz relacyjną bazę Neon Postgres, a plik `db/schema.sql` uruchom **raz** w jej edytorze SQL. Nie publikuj adresu `DATABASE_URL`.
2. Zweryfikuj domenę nadawczą w Resend i ustaw `RESEND_API_KEY`, `MAIL_FROM` oraz opcjonalny `MAIL_REPLY_TO` (skrzynka do odpowiedzi). Sama usługa wysyłkowa nie tworzy skrzynki odbiorczej. Sprawdź wysyłkę testową i rekordy DNS domeny.
3. Utwórz widżet Cloudflare Turnstile dla `www.golazoska.com`; ustaw `TURNSTILE_SITE_KEY` i tajny `TURNSTILE_SECRET_KEY`. Backend sprawdza token u Cloudflare.
4. Ustaw losowe, długie `ADMIN_TOKEN` i `CRON_SECRET` jako sekrety Vercel. `PUBLIC_BASE_URL=https://www.golazoska.com` i `TURNSTILE_HOSTNAME=www.golazoska.com`. Wstępnie pozostaw `RESERVATIONS_OPEN=false`.
5. Sprawdź testowy zapis, dostarczenie i kliknięcie wiadomości, anulowanie, listę rezerwową, limit oraz widok organizatora w środowisku testowym. Włącz `RESERVATIONS_OPEN=true` dopiero po podaniu ostatecznej sali i godziny, dopracowaniu informacji o przetwarzaniu danych oraz testach.

Vercel uruchamia `/api/cron` codziennie o 08:00 UTC (10:00 w Polsce w listopadzie). Wywołanie jest chronione `CRON_SECRET`. Zmiany `vercel.json` wymagają ponownego wdrożenia.

## Statusy i ręczna obsługa

| Status | Znaczenie |
| --- | --- |
| `verification` | Zgłoszenie zajmuje miejsce i czeka na sprawdzenie adresu |
| `reserved` | E-mail sprawdzony, oczekiwanie na potwierdzenie udziału |
| `confirmed` | Udział potwierdzony |
| `waiting` | Lista rezerwowa; nie uprawnia do wejścia |
| `offered` | Oferta zwolnionego miejsca, termin ograniczony |
| `cancelled` / `expired` | Miejsce zwolnione |

Przycisk „Zaproponuj” w panelu zmienia status, a e-mail z ofertą wyśle najbliższe uruchomienie zadania dziennego. Nie używaj go do miejsc stojących. Zaproszenia specjalne trzymaj na osobnej, prywatnej liście; przed wejściem sprawdź łączną liczbę publicznych rezerwacji, gości i wejść dodatkowych względem zatwierdzonej pojemności sali.

## Znane ograniczenia

- Bez bazy i kluczy e-mail formularz pozostaje zamknięty. Samo wdrożenie kodu nie przyjmuje rezerwacji.
- Wiadomość zaakceptowana do wysyłki może później odbić; organizator powinien kontrolować błędy dostarczania i ręcznie kontaktować się z takimi osobami.
- Funkcja planowana działa raz dziennie w planie Vercel Hobby. Ręczne zmiany w panelu mogą czekać do następnego uruchomienia na powiadomienie e-mail.
- Panel organizatora jest chroniony kluczem, a jego adres nie jest linkowany publicznie. Pobranego CSV nie publikuj.
- Data wysłania końcowego przypomnienia nie wystarcza do podania sali i godziny: uzupełnij te informacje w wiadomościach przed otwarciem.

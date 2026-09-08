import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderUserMd, writeUserMd } from "./profile-view.js";

describe("renderUserMd", () => {
  it("печатает только заполненное", () => {
    const md = renderUserMd({
      person: { name: "Семён", city: "Москва", country: "", tz: null },
      body: { sex: "male", age: 34 },
    });

    expect(md).toContain("**Имя:** Семён");
    expect(md).toContain("**Город:** Москва");
    // Пустая строка и null — это «не ответили». Печатать «**Страна:**» без значения
    // значит показать модели ровно тот незаполненный шаблон, из которого мы уходим.
    expect(md).not.toContain("Страна");
    expect(md).not.toContain("Часовой пояс");
    expect(md).toContain("**Возраст:** 34");
  });

  it("говорит, что профиль пуст, вместо пустого файла", () => {
    const md = renderUserMd({});

    // Пустой файл читался бы как поломка генератора, а не как «ещё не спрашивали».
    expect(md).toContain("Профиль пока пуст");
    expect(md).not.toContain("## Человек");
  });

  it("не печатает раздел, в котором нет ни одного значения", () => {
    const md = renderUserMd({ person: { name: "Семён" }, body: {} });

    expect(md).toContain("## Человек");
    expect(md).not.toContain("## Телосложение");
  });

  it("склеивает списки и переводит логические значения", () => {
    const md = renderUserMd({ person: { citizenship: ["RU", "RS"] } });

    expect(md).toContain("**Гражданство:** RU, RS");
  });

  it("не печатает поля, для которых нет подписи", () => {
    // Схема скилла может завести общее поле, о котором этот файл не знает. Печатать
    // его сырым ключом — показывать модели внутренности вместо текста про человека.
    const md = renderUserMd({ person: { name: "Семён", secret_internal_flag: "on" } });

    expect(md).toContain("Семён");
    expect(md).not.toContain("secret_internal_flag");
  });

  it("предупреждает, что файл машинный", () => {
    // Без шапки человек однажды поправит файл руками, и правку затрёт следующая
    // запись в профиль — молча.
    expect(renderUserMd({ person: { name: "Семён" } })).toContain("затрутся");
  });
});

describe("writeUserMd", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "profile-view-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("создаёт рабочую область, если её ещё нет", () => {
    const nested = join(dir, "workspace");

    expect(writeUserMd(nested, { person: { name: "Семён" } })).toBe(true);
    expect(readFileSync(join(nested, "USER.md"), "utf8")).toContain("Семён");
  });

  it("перезаписывает файл целиком", () => {
    writeUserMd(dir, { person: { name: "Семён", city: "Москва" } });
    writeUserMd(dir, { person: { name: "Семён" } });

    const md = readFileSync(join(dir, "USER.md"), "utf8");
    // Город убрали из профиля — он должен исчезнуть и из представления, иначе файл
    // накапливает то, что уже неправда.
    expect(md).not.toContain("Москва");
  });

  it("не падает, когда записать нельзя", () => {
    // `USER.md` — удобство, а не данные. Уронить `skill_state` из-за него значило бы
    // потерять уже записанный ответ человека ради печати файла.
    const impossible = join(dir, "USER.md", "nested");
    writeUserMd(dir, { person: { name: "Семён" } });

    expect(writeUserMd(impossible, { person: { name: "Семён" } })).toBe(false);
    expect(existsSync(join(dir, "USER.md"))).toBe(true);
  });
});

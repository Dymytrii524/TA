# Vendored-оголошення

## `buf/validate/validate.proto`

Оголошення правил валідації [protovalidate](https://github.com/bufbuild/protovalidate).
Потрібне для компіляції `proto/transatlas/search/v1/*.proto`: контракт
використовує `(buf.validate.field)`, `(buf.validate.message).cel` і
`(buf.validate.oneof).required`.

| | |
| --- | --- |
| Джерело | `https://raw.githubusercontent.com/bufbuild/protovalidate/<тег>/proto/protovalidate/buf/validate/validate.proto` |
| Розмір | 203 652 байти |
| Хто читає | `schemas/check_proto_contract.py`, `ci/proto_mutation.py`, `ci/proto_breaking.py`, `ci/pr_simulation.py` |

### Чому копія в репозиторії, а не завантаження в прогоні

Крок «Контракт» обовʼязковий у правилі захисту гілки. Якби він тягнув це
оголошення з мережі, недоступність зовнішнього хоста блокувала б злиття всіх
pull request, а зміна файлу вище за течією мовчки змінювала б результат
перевірки на незмінному коді. Копія в репозиторії робить прогін
детермінованим і повністю офлайновим — саме тому `ci/pr_simulation.py` працює
без мережі.

`buf` цей каталог не використовує: він бере залежність із реєстру, як
оголошено в `buf.yaml`. Каталог навмисно не оголошений модулем buf, щоб лінт
не застосовувався до сторонього коду.

### Оновлення

```bash
curl -sSfL \
  "https://raw.githubusercontent.com/bufbuild/protovalidate/<тег>/proto/protovalidate/buf/validate/validate.proto" \
  -o third_party/buf/validate/validate.proto
python schemas/check_proto_contract.py
python ci/proto_mutation.py
```

Оновлювати окремим pull request, не змішуючи зі змінами самого контракту:
інакше не буде видно, чия саме правка змінила результат перевірки.

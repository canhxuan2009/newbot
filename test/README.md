# Kiểm tra module Quest

Chạy toàn bộ test:

```sh
npm test
```

Chạy riêng bộ kiểm tra tương thích Python/Node.js:

```sh
npm run test:conformance
```

## Cấu trúc

- `fixtures/python-quest-cases.json`: payload dùng chung cho Python và Node.js.
- `fixtures/python-quest-golden.json`: kết quả chuẩn theo hành vi của dự án Python.
- `oracle/python_quest_oracle.py`: oracle Python độc lập, không gọi mạng.
- `questConformance.test.js`: so sánh Node.js với golden output và oracle Python.
- `questInfrastructure.test.js`: kiểm tra provider guard, session config, schema và interaction router.

Nếu máy có Python 3, phép so sánh trực tiếp với oracle sẽ tự động chạy. Nếu không
có Python, live oracle được bỏ qua nhưng Node.js vẫn bắt buộc phải khớp golden output.

Toàn bộ test dùng fixture hoặc mock; không kết nối Discord API và không cần MongoDB đang chạy.

# JS DEP mining test app

This is a security scanner test app focused on scanner's ability to mine
information about server-side endpoints ("data entry points" or DEPs[1]) from
client-side JS code.

The app's server side has several endpoints and each of them is accessed from
client side's JS code. They are only accessed from JS, there is no static HTML
referencing them (links, forms etc). At server side all endpoints behave
identically and have a trivial-to-exploit SQL injection in one of the
parameters. This test app can be used to test whole scanners or their modules
responsible for mining DEPs from client side separated. The full list of all
DEPs is given in the table below.

# List of DEPs

|  № | Relevant code location                                   | Request                                                                                                                                        |
|---:|:--------------------------------------------------------:| -----------------------------------------------------------------------------------------------------------------------------------------------|
|  1 | `index.html`                                             | `GET http://test.host/application/jie8Ye/interface/aesi9X/handle?Po3oom=1`                                                          |
|  2 | `index.html`                                             | `GET http://test.host/application/Yai0au/interface/Eikei0/handle?Me1ii7=1`                                                          |
|  3 | `index.html`                                             | `GET http://test.host/application/aeP2je/interface/aiH7io/handle?ieW5ie=1`                                                          |
|  4 | `static/4.js`                                            | `GET http://test.host/application/aet0Mu/interface/MooS8u/handle?veiw4I=1`                                                          |
|  5 | `static/5.js`                                            | `POST http://test.host/application/iuT6ei/interface/Eek0Mu/handle` with params `eeNgi6=1` in body in `x-www-form/urlencoded` format |
|  6 | `static/6.js`                                            | `GET http://test.host/application/gf32d2/interface/vcj442/handle?lkvo24=1`                                                          |
|  7 | `static/7.js` and `index.html`                           | `GET http://test.host/application/n3m1k2/interface/zgjj56/handle?lk90pj=1&control=asde11`                                           |
|  8 | `static/8.js`                                            | `GET http://test.host/application/p0065n/interface/zbtghr/handle?hg3f2d=4&id=12`                                                    |
|  9 | `static/9.js`                                            | `GET http://test.host/application/kl3j5h/interface/32nhj4/handle?qh44j3=1&surveiller=po89uo`                                        |
| 10 | `static/10.js`                                           | `GET http://test.host/application/thq019/interface/nhqmz8/handle?nba67x=2`                                                          |
| 11 | `static/11.js` and `index.html`                          | `GET http://test.host/application/lm3b22/interface/b1nqjc/handle?a09bku=5`                                                          |
| 12 | `static/12.js`                                           | `GET http://test.host/application/nh3k21/interface/hd73h4/handle?country=country&lang=language&phgoo9=1`                            |
| 13 | `index.html` and `static/dynamically-loaded-script.html` | `GET http://test.host/application/hgt54r/interface/t3qrv5/handle?i67u77=1`                                                          |
| 14 | `static/14.js`                                           | `GET http://test.host/application/lfi32b/interface/bjfu93/handle?nv7=91&qng1f3=2&id=1&windowpane=35129`                             |
| 15 | `static/15.js`                                           | `POST http://test.host/application/j4b2yh/interface/9fdh32/handle` with params in `multipart/form-data` format: `ffdj3v` with value `1`, `action` with value `delete` and `tag` with value `rand`      |
| 16 | `request16.html`                                         | `GET http://test.host/application/Che7ei/interface/Ua9xek/handle?abi1Lu=1`                                                          |
| 17 | `request17.html`                                         | `GET http://test.host/application/to0Hei/interface/maM2uc/handle?Pue6Ee=2`      |

# References

[1] Huang, Y. W., Huang, S. K., Lin, T. P., Tsai, C. H. “Web Application
Security Assessment by Fault Injection and Behavior Monitoring.” In Proc.
Twelfth Int’l World Wide Web Conference (WWW2003), 148-159, Budapest, Hungary,
May 21-25, 2003

// RelWarc #12: $.get with a params object built via successive property assignments, folded into the query.
function request12() {
    var request = new Object();
    request.country = "country";
    request.lang = "language";
    request.phgoo9 = "1";
    url = "/application/nh3k21/interface/hd73h4/handle";
    $.get(url,request);
}

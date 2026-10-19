// RelWarc #6: $.ajax reading the URL from a variable, with a data string appended as the query.
function request6() {
    var url = "/application/gf32d2/interface/vcj442/handle";
    var param = "lkvo24=1";
    $.ajax({
        type: "GET",
        url: url,
        data: param
    });
}

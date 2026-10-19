// RelWarc #15: $.ajax POST whose body is a FormData object — the endpoint URL is a plain literal.
function request15() {
    var data = new FormData();
    data.append('ffdj3v', '1');
    data.append('action', 'delete');
    data.append('tag', 'rand');
    $.ajax({
        type: 'POST',
        url: "/application/j4b2yh/interface/9fdh32/handle",
        data: data,
        processData: false,
        contentType: false
    });
}
